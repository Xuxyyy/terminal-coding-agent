import {
  createClient,
  judgeModelFor,
  MAX_OUTPUT_TOKENS,
  StreamFailure,
  streamStep,
  type ModelChoice,
} from './client.js';
import {INTERRUPTED, INTERRUPTED_TURN, type Host, type Usage} from './host.js';
import {explainError} from './errors.js';
import {compactSession, withoutText} from './compact.js';
import {assistantMessage} from './messages.js';
import {
  projectedTokens,
  recordToolUsage,
  recordUsage,
  overThreshold,
  type Session,
} from './session.js';
import type {SessionStore} from './store.js';
import {captureSnapshot} from './history.js';
import {estimateTokens} from './tokens.js';
import {runTool, toolDefinitions, toolsFor} from './tools/index.js';
import {displayPath, resolveTarget} from './tools/paths.js';
import type {Judge, Tool} from './tools/registry.js';
import {askJudge, judgeMessages} from './permission/judge.js';
import {NORMAL_STEP_POLICY} from './step-policy.js';

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

function messagesForStep(
  session: Session,
  step: number,
  maxSteps?: number,
): Session['messages'] {
  const budgetWarning = maxSteps !== undefined &&
    step === Math.max(1, maxSteps - NORMAL_STEP_POLICY.softAuditEvery);
  if (!shouldAudit(step) && !budgetWarning) return session.messages;
  const messages = [...session.messages];
  const first = messages[0];
  if (first?.role !== 'system' || typeof first.content !== 'string') {
    return session.messages;
  }
  const boundary = maxSteps ??
    (Math.floor(step / NORMAL_STEP_POLICY.hardGateEvery) + 1) * NORMAL_STEP_POLICY.hardGateEvery;
  const remaining = boundary - step;
  const boundaryName = maxSteps === undefined ? 'continuation checkpoint' : 'step limit';
  const progress = `Progress review: ${step} model turns completed. ` +
    `${remaining} model turns remain before the next ${boundaryName}, at turn ${boundary}.`;
  const closing = remaining <= NORMAL_STEP_POLICY.softAuditEvery
    ? '\n\nPlan the remaining implementation and verification work within this budget segment. ' +
      'If completion is not possible, clearly report what remains unfinished.'
    : '';
  messages[0] = {...first, content: `${first.content}\n\n${progress}\n\n${COMPLETION_AUDIT}${closing}`};
  return messages;
}

function judgeFor(session: Session, host: Host, model: string): Judge | undefined {
  if (session.mode !== 'auto') return undefined;
  let choice: ModelChoice | null = null;
  try {
    choice = createClient(judgeModelFor(model));
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
  options: {maxSteps?: number} = {},
): Promise<'step_limit' | void> {
  const {maxSteps} = options;
  const definitions = toolDefinitions(registry);
  const judge = judgeFor(session, host, choice.model);
  const total: Usage = {prompt: 0, completion: 0, total: 0};
  let warned = false;
  let reportedThreshold = false;

  const backup = store
    ? (asked: string, snapshot: Buffer | null): void => {
        const target = resolveTarget(session.root, asked);
        const before = captureSnapshot(store.dir, snapshot);
        store.appendCode(displayPath(session.root, target), before);
      }
    : undefined;

  const save = (usage: Usage): void => {
    if (!store) return;
    try {
      store.appendStep(session.messages, usage);
    } catch {
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
    for (let step = 0; ; step += 1) {
      if (host.signal.aborted) {
        markInterrupted();
        return;
      }
      if (maxSteps !== undefined && step >= maxSteps) {
        host.onEvent({
          type: 'error',
          message: `stopped after ${step} model turns: step budget exhausted`,
        });
        host.onEvent({type: 'turn_end', usage: total});
        return 'step_limit';
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
        const result = await compactSession(
          session,
          choice,
          withoutText(host),
          store,
          task ? [task] : [],
        );
        if (task && !result) session.messages.push(task);
        host.onEvent({
          type: 'compact_end',
          replaced: result?.replaced ?? 0,
          before: result?.before ?? 0,
          after: result?.after ?? 0,
        });
        if (!result) {
          host.onEvent({
            type: 'error',
            message: 'could not compact; the run stopped',
          });
          host.onEvent({type: 'turn_end', usage: total});
          return;
        }
        addUsage(total, result.usage);
        addUsage(session.usage, result.usage);
      }

      const requestMessages = messagesForStep(session, step, maxSteps);
      const auditTokens = requestMessages === session.messages
        ? 0
        : estimateTokens(
            (requestMessages[0]!.content as string).slice(
              (session.messages[0]!.content as string).length,
            ),
          );
      if (
        projectedTokens(session, registry) + auditTokens + MAX_OUTPUT_TOKENS >
        session.contextWindow
      ) {
        host.onEvent({
          type: 'error',
          message: 'stopped: the next request would exceed the context window',
        });
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

      const result = await streamStep(choice, requestMessages, definitions, host);
      addUsage(total, result.usage);
      session.messages.push(
        assistantMessage(result.content, result.toolCalls, result.continuation),
      );
      recordUsage(session, result.usage);

      if (result.toolCalls.length === 0) {
        if (result.finishReason === 'length') {
          host.onEvent({
            type: 'error',
            message: 'the model hit its output limit; ask it to continue',
          });
        }
        save(result.usage);
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

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
        });
      }
      save(result.usage);
    }
  } catch (error) {
    const partial = error instanceof StreamFailure ? error.partial : null;
    if (partial?.content) {
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
  }
}
