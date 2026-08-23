import type OpenAI from 'openai';
import {
  createClient,
  judgeModelFor,
  MAX_OUTPUT_TOKENS,
  StreamFailure,
  streamStep,
  type ModelChoice,
} from './client.js';
import type {Host, Usage} from './host.js';
import {clearRecoverable} from './clear.js';
import {compactSession, withoutText} from './compact.js';
import {
  contextThreshold,
  projectedTokens,
  recordUsage,
  overThreshold,
  type Session,
} from './session.js';
import type {SessionStore} from './store.js';
import {captureBefore} from './history.js';
import {runTool, toolDefinitions, toolsFor} from './tools/index.js';
import {displayPath, resolveTarget} from './tools/paths.js';
import type {Judge, Tool} from './tools/registry.js';
import {askJudge, judgeMessages} from './permission/judge.js';

export const MAX_STEPS = 20;

export const INTERRUPTED = '[interrupted by the user]';

function aborted(error: unknown, host: Host): boolean {
  return (
    host.signal.aborted ||
    (error as Error)?.name === 'AbortError' ||
    (error as Error)?.name === 'APIUserAbortError'
  );
}

function assistantMessage(
  content: string,
  calls: {id: string; name: string; args: string}[],
): OpenAI.ChatCompletionMessageParam {
  if (calls.length === 0) {
    return {role: 'assistant', content};
  }
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {name: call.name, arguments: call.args},
    })),
  };
}

const NO_USAGE: Usage = {prompt: 0, completion: 0, total: 0};

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
): Promise<void> {
  const definitions = toolDefinitions(registry);
  const judge = judgeFor(session, host, choice.model);
  const total: Usage = {prompt: 0, completion: 0, total: 0};
  let warned = false;
  let checkpoints = true;
  let reportedThreshold = false;

  const backup = store
    ? (asked: string): void => {
        const target = resolveTarget(session.root, asked);
        const before = captureBefore(store.dir, target);
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

  try {
    for (let step = 0; ; step += 1) {
      if (host.signal.aborted) return;
      if (checkpoints && step > 0 && step % MAX_STEPS === 0) {
        const answer = await host.confirm({
          command: 'continue',
          reason: `${step} steps without finishing`,
          suppressible: true,
        });
        if (answer === 'deny') {
          host.onEvent({
            type: 'error',
            message: `stopped after ${step} steps without finishing`,
          });
          host.onEvent({type: 'turn_end', usage: total});
          return;
        }
        if (answer === 'session') checkpoints = false;
      }

      if (
        step === 0 &&
        (overThreshold(session, process.env, registry) || session.clearingExhausted)
      ) {
        const freed = clearRecoverable(
          session,
          session.contextWindow * contextThreshold(),
          registry,
        );
        const stuck = session.clearingExhausted && freed === 0;
        if (stuck || overThreshold(session, process.env, registry)) {
          const last = session.messages[session.messages.length - 1];
          const task = last?.role === 'user' ? last : null;
          if (task) session.messages.pop();
          host.onEvent({type: 'compact_start'});
          const result = await compactSession(
            session,
            choice,
            withoutText(host),
            store,
          );
          if (task) session.messages.push(task);
          if (result) {
            addUsage(total, result.usage);
            addUsage(session.usage, result.usage);
          } else {
            host.onEvent({
              type: 'error',
              message: 'could not compact; the run continues',
            });
          }
          host.onEvent({
            type: 'compact_end',
            replaced: result?.replaced ?? 0,
            before: result?.before ?? 0,
            after: result?.after ?? 0,
          });
        }
        session.clearingExhausted = false;
      }

      if (step > 0 && overThreshold(session, process.env, registry)) {
        const target = session.contextWindow * contextThreshold();
        const freed = clearRecoverable(session, target, registry);
        if (freed > 0) {
          session.clearingExhausted = false;
          host.onEvent({type: 'context_cleared', freed});
        } else {
          session.clearingExhausted = true;
          if (!reportedThreshold) {
            reportedThreshold = true;
            host.onEvent({type: 'context_threshold_reached'});
          }
        }
      }

      if (
        projectedTokens(session, registry) + MAX_OUTPUT_TOKENS >
        session.contextWindow
      ) {
        host.onEvent({
          type: 'error',
          message:
            'stopped: the context is full and nothing more can be freed; send your next message and it will compact first',
        });
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

      const result = await streamStep(choice, session.messages, definitions, host);
      addUsage(total, result.usage);
      session.messages.push(assistantMessage(result.content, result.toolCalls));
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
          backup,
          judge,
          denied: session.denied,
        });
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
      session.messages.push(assistantMessage(partial.content, []));
    }
    save(partial?.usage ?? NO_USAGE);
    if (aborted(error, host)) return;
    host.onEvent({type: 'error', message: (error as Error).message});
    host.onEvent({type: 'turn_end', usage: total});
  }
}
