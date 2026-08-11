import type OpenAI from 'openai';
import {streamTurn, type ModelChoice} from './client.js';
import type {Host, Usage} from './host.js';
import {recordUsage, type Session} from './session.js';
import type {SessionStore} from './store.js';
import {runTool, toolDefinitions, tools as defaultTools} from './tools/index.js';
import type {Tool} from './tools/registry.js';

export const MAX_TURNS = 20;

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

export async function runAgent(
  session: Session,
  choice: ModelChoice,
  host: Host,
  registry: Tool[] = defaultTools,
  store?: SessionStore,
): Promise<void> {
  const definitions = toolDefinitions(registry);
  const total: Usage = {prompt: 0, completion: 0, total: 0};

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const result = await streamTurn(choice, session.messages, definitions, host);
      recordUsage(session, result.usage);
      total.prompt += result.usage.prompt;
      total.completion += result.usage.completion;
      total.total += result.usage.total;
      session.messages.push(assistantMessage(result.content, result.toolCalls));

      if (result.toolCalls.length === 0) {
        if (result.finishReason === 'length') {
          host.onEvent({
            type: 'error',
            message: 'the model hit its output limit; ask it to continue',
          });
        }
        host.onEvent({type: 'turn_end', usage: total});
        return;
      }

      for (const call of result.toolCalls) {
        if (host.signal.aborted) return;
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
    }
    host.onEvent({
      type: 'error',
      message: `stopped after ${MAX_TURNS} turns without finishing`,
    });
    host.onEvent({type: 'turn_end', usage: total});
  } catch (error) {
    if (aborted(error, host)) return;
    host.onEvent({type: 'error', message: (error as Error).message});
    host.onEvent({type: 'turn_end', usage: total});
  }
}
