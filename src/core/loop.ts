import {randomUUID} from 'node:crypto';
import {decideRecovery} from './recovery.js';
import {
  createJudgeClient,
  MAX_OUTPUT_TOKENS,
  StreamFailure,
  streamStep,
  type ModelChoice,
} from './client.js';
import {INTERRUPTED, INTERRUPTED_TURN, type Host, type Usage} from './host.js';
import {explainError} from './errors.js';
import {compactSession, CompactionSaveError, withoutText} from './compact.js';
import {assistantDraftMessage, assistantMessage} from './messages.js';
import {
  projectedTokens,
  recordToolUsage,
  restoreMessages,
  setMeasured,
  overThreshold,
  type Session,
} from './session.js';
import type {SessionStore} from './store.js';
import {lastUsageOf, messagesOf, recoverToolResults} from './records.js';
import {captureSnapshot} from './history.js';
import {runTool, toolDefinitions, toolsFor} from './tools/index.js';
import {displayPath, resolveTarget} from './tools/paths.js';
import type {Judge, Tool} from './tools/registry.js';
import {askJudge, judgeMessages} from './permission/judge.js';
import {NORMAL_STEP_POLICY} from './step-policy.js';
import type {BackgroundTasks} from './background.js';
import {AgentRuntime} from './agent-runtime.js';
import {waitForChange} from './wait-for-change.js';

export {NORMAL_STEP_POLICY};

export const COMPLETION_AUDIT =
  'Reassess the original request and the evidence collected. ' +
  'If all required work is complete and verified, stop using tools and answer. ' +
  'Otherwise, identify the essential work still missing and take the next useful action. ' +
  'Prioritize required behavior and necessary verification before optional improvements. ' +
  'Avoid repeating checks unless new evidence makes them useful. Do not claim completion without evidence.';

export {INTERRUPTED, INTERRUPTED_TURN};

function aborted(error: unknown, host: Host): boolean {
  return (
    host.signal.aborted ||
    (error as Error)?.name === 'AbortError' ||
    (error as Error)?.name === 'APIUserAbortError'
  );
}

const NO_USAGE: Usage = {prompt: 0, completion: 0, total: 0};

function shouldAudit(step: number): boolean {
  return step > 0 && step % NORMAL_STEP_POLICY.softAuditEvery === 0;
}

function reminderForStep(
  step: number,
  maxSteps?: number,
): Session['messages'][number] | null {
  const boundary = maxSteps ??
    (Math.floor(step / NORMAL_STEP_POLICY.hardGateEvery) + 1) * NORMAL_STEP_POLICY.hardGateEvery;
  const budgetWarning = step === Math.max(1, boundary - NORMAL_STEP_POLICY.finalWarningAt);
  if (!shouldAudit(step) && !budgetWarning) return null;
  const remaining = boundary - step;
  const boundaryName = maxSteps === undefined ? 'continuation checkpoint' : 'step limit';
  const progress = `Progress review: ${step} model turns completed. ` +
    `${remaining} model turns remain before the next ${boundaryName}, at turn ${boundary}.`;
  const closing = remaining <= NORMAL_STEP_POLICY.finalWarningAt
    ? '\n\nPlan the remaining implementation and verification work within this budget segment. ' +
      'If completion is not possible, clearly report what remains unfinished.'
    : '';
  return {role: 'system', content: `${progress}\n\n${COMPLETION_AUDIT}${closing}`};
}

function judgeFor(session: Session, host: Host): Judge | undefined {
  if (session.mode !== 'auto') return undefined;
  let choice: ModelChoice | null = null;
  try {
    choice = createJudgeClient();
  } catch {
    choice = null;
  }
  return async (request, reason) => {
    if (!choice) return 'ask';
    return askJudge(
      choice,
      judgeMessages({
        asked: session.asked,
        messages: session.messages,
        root: session.root,
        request,
        reason,
        denied: session.denied,
      }),
      host.signal,
      host.onModelUsage,
      host.onEvent,
      `${host.agentId ?? 'main'}/judge`,
    );
  };
}

function addUsage(target: Usage, usage: Usage): void {
  target.prompt += usage.prompt;
  target.completion += usage.completion;
  target.total += usage.total;
}

export async function runAgent(
  session: Session,
  choice: ModelChoice,
  host: Host,
  registry: Tool[] = toolsFor(session.mode),
  store?: SessionStore,
  options: {maxSteps?: number; backgroundTasks?: BackgroundTasks; waitForBackground?: boolean; durableTools?: boolean; agents?: AgentRuntime; inboxId?: string; onWait?: (waiting: boolean) => void} = {},
): Promise<'step_limit' | void> {
  const {backgroundTasks} = options;
  const waitForBackground = options.waitForBackground ?? Boolean(backgroundTasks);
  const maxSteps = options.maxSteps ?? host.maxSteps;
  const definitions = toolDefinitions(registry);
  const total: Usage = {prompt: 0, completion: 0, total: 0};
  const outerHost = host;
  host = {...host, agentId: host.agentId ?? randomUUID(), onEvent(event) {
    if (event.type === 'model_attempt' && event.evidence.usage) {
      const reported = event.evidence.usage;
      const usage = {prompt: reported.inputTokens, completion: reported.outputTokens, total: reported.totalTokens};
      addUsage(total, usage);
      recordToolUsage(session, usage);
    }
    outerHost.onEvent(event);
  }};
  const inboxId = options.inboxId ?? 'main';
  const ownsAgents = !options.inboxId;
  let agents = options.agents;
  const accounted = session.agentUsage ??= new Set<string>();
  const accountAgentUsage = (id: string, usage: Usage) => {
    if (accounted.has(id)) return;
    accounted.add(id);
    addUsage(total, usage);
    recordToolUsage(session, usage);
  };
  if (ownsAgents) host = {...host, confirm: (request, signal = host.signal) => agents ? agents.confirm(request, signal, 'main') : outerHost.confirm(request, signal)};
  const judge = judgeFor(session, host);
  let continuationUsed = false;
  let nextRequestId = randomUUID();
  let warned = false;
  let reportedThreshold = false;

  const backup = store
    ? (asked: string, snapshot: Buffer | null): void => {
        const target = resolveTarget(session.root, asked);
        const before = captureSnapshot(store.dir, snapshot);
        store.appendCode(displayPath(session.root, target), before);
      }
    : undefined;

  const save = (usage: Usage, required = options.durableTools): void => {
    if (!store) return;
    try {
      store.appendStep(session.messages, usage);
    } catch (error) {
      if (required) throw error;
      if (warned) return;
      warned = true;
      host.onEvent({
        type: 'error',
        message: 'could not save the session; the run continues',
      });
    }
  };

  const markInterrupted = (): void => {
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'user' && last.content === INTERRUPTED_TURN) return;
    session.messages.push({role: 'user', content: INTERRUPTED_TURN});
    save(NO_USAGE);
  };

  try {
    if (ownsAgents && !agents) agents = new AgentRuntime(outerHost, store);
    if (ownsAgents && agents) agents.accountUsage = accountAgentUsage;
    if (ownsAgents && store) {
      const recovery = recoverToolResults(session.messages);
      if (recovery.recovered.length) store.appendStep(recovery.recovered, NO_USAGE);
      session.messages = recovery.messages;
    }
    for (let step = 0; ; step += 1) {
      if (host.signal.aborted) {
        markInterrupted();
        return;
      }
      agents?.check();
      const durable = options.durableTools || Boolean(store && agents?.list().length);
      if (maxSteps !== undefined && step >= maxSteps) {
        host.onEvent({
          type: 'error',
          message: `stopped after ${step} model turns: step budget exhausted`,
        });
        host.onEvent({type: 'turn_end', usage: total});
        return 'step_limit';
      }
      for (const event of agents?.mail.deliver(inboxId, session, store) ?? []) {
        if (event.usage) {
          accountAgentUsage(event.id, event.usage);
        }
      }
      const completed = backgroundTasks?.drain() ?? [];
      if (completed.length > 0) {
        session.messages.push({
          role: 'user',
          name: 'acc_runtime',
          content: '[runtime background task completion notice]\n' +
            completed.map((task) => JSON.stringify(task)).join('\n') +
            '\nThis is a runtime event, not a human message or approval. Use task_output with each task id to read its saved output, check its exit status and result, and handle failures before reporting completion.',
        });
        save(NO_USAGE);
      }
      if (
        maxSteps === undefined &&
        step > 0 && step % NORMAL_STEP_POLICY.hardGateEvery === 0
      ) {
        const answer = await host.confirm({
          command: 'continue',
          reason:
            `${step} steps without finishing; continue for up to ` +
            `${NORMAL_STEP_POLICY.hardGateEvery} more steps`,
          suppressible: false,
        });
        if (host.signal.aborted) {
          markInterrupted();
          return;
        }
        if (answer === 'deny') {
          host.onEvent({
            type: 'error',
            message: `stopped after ${step} steps without finishing`,
          });
          host.onEvent({type: 'turn_end', usage: total});
          return;
        }
      }

      if (overThreshold(session, process.env, registry)) {
        if (!reportedThreshold) {
          reportedThreshold = true;
          host.onEvent({type: 'context_threshold_reached'});
        }
        const last = session.messages[session.messages.length - 1];
        const task = step === 0 && last?.role === 'user' ? last : null;
        if (task) session.messages.pop();
        host.onEvent({type: 'compact_start'});
        let result: Awaited<ReturnType<typeof compactSession>> = null;
        try {
          result = await compactSession(
            session,
            choice,
            withoutText(host),
            store,
            task ? [task] : [],
            {requireSave: durable},
          );
        } finally {
          if (task && !result) session.messages.push(task);
          host.onEvent({
            type: 'compact_end',
            replaced: result?.replaced ?? 0,
            before: result?.before ?? 0,
            after: result?.after ?? 0,
          });
        }
        if (!result) {
          host.onEvent({
            type: 'error',
            message: 'could not compact; the run stopped',
          });
          host.onEvent({type: 'turn_end', usage: total});
          return;
        }

      }

      const reminder = reminderForStep(step, maxSteps);
      if (reminder) session.messages.push(reminder);
      if (
        projectedTokens(session, registry) + MAX_OUTPUT_TOKENS >
        session.contextWindow
      ) {
        if (reminder) session.messages.pop();
        host.onEvent({
          type: 'error',
          message: 'stopped: the next request would exceed the context window',
        });
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

      if (reminder) save(NO_USAGE);
      host.onEvent({type: 'model_request_start', request: step + 1});
      const requestId = nextRequestId;
      nextRequestId = randomUUID();
      const budget = {attempts: 0};
      let compacted = false;
      let result: Awaited<ReturnType<typeof streamStep>>;
      for (;;) {
        try {
          result = await streamStep(choice, session.messages, definitions, host, {
            budget, requestId, recovery: {continuationUsed, contextRecovered: compacted},
          });
          break;
        } catch (error) {
          const recovery = decideRecovery({kind: 'failure', error, partial: error instanceof StreamFailure ? error.partial : undefined}, {
            continuationUsed, contextRecovered: compacted, attempts: budget.attempts, aborted: host.signal.aborted,
          });
          if ('partial' in recovery) {
            result = {...recovery.partial, finishReason: 'length'};
            break;
          }
          if (recovery.action !== 'context') throw error;
          compacted = true;
          host.onEvent({type: 'recovery', kind: 'context', requestId, agentId: host.agentId!, recoveryId: randomUUID(), startedAt: new Date().toISOString()});
          host.onEvent({type: 'compact_start'});
          let compact: Awaited<ReturnType<typeof compactSession>> = null;
          try {
            compact = await compactSession(session, choice, withoutText(host), store, [], {requireSave: durable});
          } finally {
            host.onEvent({type: 'compact_end', replaced: compact?.replaced ?? 0, before: compact?.before ?? 0, after: compact?.after ?? 0});
          }
          if (!compact || compact.after >= compact.before || projectedTokens(session, registry) + MAX_OUTPUT_TOKENS > session.contextWindow) throw new Error('context recovery exhausted: compaction could not make the request fit');
        }
      }
      const recovery = decideRecovery({kind: 'response', response: result}, {
        continuationUsed, contextRecovered: compacted, attempts: budget.attempts, aborted: host.signal.aborted,
      });
      session.messages.push(
        result.toolCallDrafts?.length
          ? assistantDraftMessage(result.content, result.toolCallDrafts, result.continuation)
          : assistantMessage(result.content, result.toolCalls, result.continuation),
      );
      if (result.usage.total) setMeasured(session, result.usage.total);

      if (result.toolCalls.length === 0) {
        if ('partial' in recovery) {
          host.onEvent({type: 'response_incomplete', agentId: host.agentId!, reason: result.toolCallDrafts?.length ? 'tool call generation incomplete' : 'text generation incomplete'});
          session.messages.push({role: 'user', content: result.toolCallDrafts?.length
            ? '[runtime: the preceding response hit the output limit. No tool-call draft from that response was executed. Use the saved reasoning and drafts to choose the next action. Send a complete valid tool call with all required arguments if needed. Do not append argument fragments or assume any draft tool ran.]'
            : '[runtime: the preceding answer is incomplete. Continue from where it stopped. Do not repeat completed work.]'});
          save(result.usage);
          if (recovery.action === 'stop') throw new Error('text continuation exhausted: response remains incomplete');
          continuationUsed = true;
          host.onEvent({type: 'recovery', kind: 'continuation', requestId: nextRequestId, fromRequestId: requestId, agentId: host.agentId!, recoveryId: randomUUID(), startedAt: new Date().toISOString()});
          continue;
        }
        save(result.usage);
        const unverified = waitForBackground ? backgroundTasks?.unverifiedServices() ?? [] : [];
        if (result.finishReason !== 'length' && unverified.length > 0) {
          session.messages.push({role: 'user', name: 'acc_runtime', content: '[runtime: retained services still need readiness verification]\n' +
            unverified.map((task) => JSON.stringify(task)).join('\n') +
            '\nUse task_handoff to check the user-requested behavior, or task_stop if the service should not remain. ACC cannot hand off an unverified service.'});
          save(NO_USAGE);
          continue;
        }
        if (agents?.mail.pending(inboxId).length) continue;
        const tasks = result.finishReason !== 'length' && waitForBackground ? backgroundTasks : undefined;
        const children = ownsAgents ? agents : undefined;
        const waitingForTasks = Boolean(tasks?.hasPending());
        const waitingForChildren = Boolean(children?.running());
        if (waitingForTasks || waitingForChildren) {
          if (!waitingForTasks || maxSteps === undefined || step + 1 < maxSteps) {
            options.onWait?.(true);
            try {
              await waitForChange(() => {
                agents?.check();
                return Boolean(tasks?.hasNotices() || agents?.mail.pending(inboxId).length ||
                  (waitingForTasks && !tasks?.hasPending()) || (waitingForChildren && !children?.running()));
              }, [
                ...(tasks ? [(listener: () => void) => tasks.subscribe(listener)] : []),
                ...(agents ? [(listener: () => void) => agents!.subscribe(listener)] : []),
              ], host.signal);
            } finally {
              options.onWait?.(false);
            }
          }
          continue;
        }
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

      const durableRound = durable || result.toolCalls.some((call) => ['agent', 'send_message', 'wait_agents', 'stop_agent'].includes(call.name));
      if (durableRound) save(result.usage, true);
      for (const call of result.toolCalls) {
        if (host.signal.aborted) {
          session.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: INTERRUPTED,
          });
          continue;
        }
        let args: unknown = call.args;
        try {
          args = JSON.parse(call.args || '{}');
        } catch {
          args = call.args;
        }
        host.onEvent({
          type: 'tool_start',
          id: call.id,
          name: call.name,
          args,
        });
        const output = await runTool(registry, call.name, call.args, {
          root: session.root,
          host,
          allowed: session.allowed,
          rules: session.rules,
          mode: session.mode,
          sandbox: session.sandbox,
          choice,
          backup,
          judge,
          denied: session.denied,
          backgroundTasks,
          store,
          agents, inboxId, authorizationTasks: session.asked,
        });
        if (output.usage) {
          addUsage(total, output.usage);
          recordToolUsage(session, output.usage);
        }
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: output.text,
        });
        host.onEvent({
          type: 'tool_end',
          id: call.id,
          name: call.name,
          result: output.text,
          diff: output.diff ?? null,
          execution: output.execution,
        });
        if (durableRound) save(NO_USAGE, true);
      }
      save(durableRound ? NO_USAGE : result.usage, durableRound);
    }
  } catch (error) {
    if (error instanceof CompactionSaveError) {
      let message = error.message;
      if (store) {
        try {
          const records = store.records();
          if (records.length === 0) throw new Error('saved history is unavailable');
          const asked = session.asked;
          restoreMessages(session, messagesOf(records));
          if (options.inboxId && options.inboxId !== 'main') session.asked = asked;
          setMeasured(session, lastUsageOf(records)?.total ?? 0);
          store.seed(session.messages);
        } catch {
          message += '\nCould not reload saved history; reopen the session after fixing storage.';
        }
      }
      host.onEvent({type: 'error', message});
      host.onEvent({type: 'turn_end', usage: total});
      return;
    }
    const partial = error instanceof StreamFailure ? error.partial : null;
    if (partial?.content && partial.toolCalls.length === 0) {
      host.onEvent({type: 'response_incomplete', agentId: host.agentId!, reason: aborted(error, host) ? 'interrupted' : 'generation failed'});
      session.messages.push(
        assistantMessage(partial.content, [], partial.continuation),
      );
    }
    save(partial?.usage ?? NO_USAGE);
    if (aborted(error, host)) {
      markInterrupted();
      return;
    }
    const explained = explainError(error, choice.model);
    host.onEvent({type: 'error', ...explained});
    host.onEvent({type: 'turn_end', usage: total});
  } finally {
    if (ownsAgents) await agents?.close();
  }
}
