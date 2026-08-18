import type OpenAI from 'openai';
import type {ModelChoice} from '../core/client.js';
import type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
  Host,
} from '../core/host.js';
import type {SessionStore} from '../core/store.js';

export function textChunk(text: string): unknown {
  return {choices: [{index: 0, delta: {content: text}, finish_reason: null}]};
}

export function toolCallChunk(
  id: string,
  name: string,
  args: string,
  index = 0,
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {index, id, type: 'function', function: {name, arguments: args}},
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function finishChunk(reason: string): unknown {
  return {choices: [{index: 0, delta: {}, finish_reason: reason}]};
}

export function usageChunk(prompt: number, completion: number): unknown {
  return {
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

export function streamOf(...parts: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        if (part instanceof Error) throw part;
        yield part;
      }
    },
  };
}

export function connectionError(): Error {
  const error = new Error('Connection error.');
  error.name = 'APIConnectionError';
  return error;
}

export function statusError(status: number): Error {
  return Object.assign(new Error(`status ${status}`), {status});
}

export function abortError(name = 'APIUserAbortError'): Error {
  const error = new Error('Request was aborted.');
  error.name = name;
  return error;
}

export function fakeModel(next: (nth: number) => unknown): {
  choice: ModelChoice;
  calls: () => number;
} {
  let nth = 0;
  const create = async (): Promise<unknown> => {
    nth += 1;
    const result = next(nth);
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-model',
      label: 'Fake',
      contextWindow: 1_000_000,
    },
    calls: () => nth,
  };
}

export function fakeHost(
  answer: (request: ConfirmRequest, nth: number) => ConfirmDecision = () =>
    'once',
): {
  host: Host;
  events: AgentEvent[];
  asked: ConfirmRequest[];
  controller: AbortController;
} {
  const events: AgentEvent[] = [];
  const asked: ConfirmRequest[] = [];
  const controller = new AbortController();
  const host: Host = {
    signal: controller.signal,
    onEvent(event) {
      events.push(event);
    },
    async confirm(request) {
      asked.push(request);
      return answer(request, asked.length);
    },
  };
  return {host, events, asked, controller};
}

export function fakeStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    id: 'fake',
    dir: '/fake',
    seed() {},
    appendMessage: () => 'deadbeef',
    appendStep() {},
    appendCompact() {},
    appendView() {},
    appendCode() {},
    records: () => [],
    rewind() {},
    close() {},
    ...overrides,
  };
}
