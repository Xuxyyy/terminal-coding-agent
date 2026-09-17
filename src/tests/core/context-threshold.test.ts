import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  fakeHost,
  fakeStore,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import {MAX_OUTPUT_TOKENS, type ModelChoice} from '../../core/client.js';
import {compactionPrompt, SUMMARY_PREFIX} from '../../core/compact.js';
import type {AgentEvent} from '../../core/host.js';
import {runAgent} from '../../core/loop.js';
import {addTask, createSession, type Session} from '../../core/session.js';
import type {Tool} from '../../core/tools/registry.js';

type Message = OpenAI.ChatCompletionMessageParam;

const STORY =
  'The user asked to inspect the large fixture. The complete file result was read, ' +
  'its evidence was retained, and the next request should finish the same task now.';
const BIG_READ = `sentinel-start\n${'a'.repeat(440_000)}\nsentinel-end`;
const SMALL_READ = 'a'.repeat(20_000);

function session(): Session {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  addTask(active, 'inspect the fixture');
  return active;
}

function reader(body: string): Tool {
  return {
    name: 'read_file',
    description: 'returns a fixture',
    schema: z.object({}),
    async run() {
      return {text: body};
    },
  };
}

function toolResponse(n: number, total: number): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${n}`, 'read_file', '{}'),
    finishChunk('tool_calls'),
    usageChunk(total - 2, 2),
  );
}

function textResponse(text: string, total = 12): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(total - 2, 2));
}

function recordingModel(next: (nth: number) => unknown): {
  choice: ModelChoice;
  calls: () => number;
  sent: () => Message[][];
} {
  let nth = 0;
  const requests: Message[][] = [];
  const create = async (body: unknown): Promise<unknown> => {
    nth += 1;
    requests.push([...((body as {messages?: Message[]}).messages ?? [])]);
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
    sent: () => requests,
  };
}

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

function count(events: AgentEvent[], type: AgentEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

async function withThreshold(
  value: string,
  run: () => Promise<void>,
): Promise<void> {
  const before = process.env.ACC_COMPACT_AT;
  process.env.ACC_COMPACT_AT = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.ACC_COMPACT_AT;
    else process.env.ACC_COMPACT_AT = before;
  }
}

test('a recorded tool result crosses the projected line and compacts before the next request', async () => {
  const model = recordingModel((nth) => {
    if (nth === 1) return toolResponse(nth, 700_000);
    if (nth === 2) return textResponse(STORY);
    return textResponse('done');
  });
  const {host, events} = fakeHost();
  const order: string[] = [];
  const store = fakeStore({
    appendStep() {
      order.push('step');
    },
    appendCompact() {
      order.push('compact');
    },
  });
  const active = session();

  await runAgent(active, model.choice, host, [reader(BIG_READ)], store);

  assert.equal(model.calls(), 3);
  assert.deepEqual(order, ['step', 'compact', 'step']);
  assert.equal(count(events, 'context_threshold_reached'), 1);
  assert.equal(count(events, 'compact_start'), 1);
  assert.equal(count(events, 'compact_end'), 1);
  assert.deepEqual(errors(events), []);

  const compactRequest = model.sent()[1]!;
  assert.equal(compactRequest.at(-1)?.content, compactionPrompt());
  assert.ok(
    compactRequest.some((message) => message.role === 'tool' && message.content === BIG_READ),
    'the summarizer must receive the complete tool result',
  );

  const followUp = model.sent()[2]!;
  assert.ok(
    followUp.some(
      (message) =>
        message.role === 'assistant' && message.content === SUMMARY_PREFIX + STORY,
    ),
  );
  assert.equal(
    followUp.some((message) => message.role === 'tool' && message.content === BIG_READ),
    false,
  );
  assert.equal(active.messages.at(-1)?.content, 'done');
});

test('an estimated delta below the line sends the next request without compaction', async () => {
  const model = recordingModel((nth) =>
    nth === 1 ? toolResponse(nth, 700_000) : textResponse('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(session(), model.choice, host, [reader(SMALL_READ)]);

  assert.equal(model.calls(), 2);
  assert.equal(count(events, 'context_threshold_reached'), 0);
  assert.equal(count(events, 'compact_start'), 0);
  assert.ok(
    model.sent()[1]!.some(
      (message) => message.role === 'tool' && message.content === SMALL_READ,
    ),
  );
});

test('the threshold notice is emitted at most once across two compactions', async () => {
  const model = recordingModel((nth) => {
    if (nth === 1 || nth === 3) return toolResponse(nth, 900_000);
    if (nth === 2 || nth === 4) return textResponse(STORY);
    return textResponse('done');
  });
  const {host, events} = fakeHost();

  await runAgent(session(), model.choice, host, [reader(SMALL_READ)]);

  assert.equal(model.calls(), 5);
  assert.equal(count(events, 'context_threshold_reached'), 1);
  assert.equal(count(events, 'compact_start'), 2);
  assert.equal(count(events, 'compact_end'), 2);
});

test('ACC_COMPACT_AT controls the single automatic threshold', async () => {
  await withThreshold('0.1', async () => {
    const crossing = recordingModel((nth) => {
      if (nth === 1) return toolResponse(nth, 100_000);
      if (nth === 2) return textResponse(STORY);
      return textResponse('done');
    });
    const under = recordingModel((nth) =>
      nth === 1 ? toolResponse(nth, 90_000) : textResponse('done'),
    );
    const first = fakeHost();
    const second = fakeHost();

    await runAgent(session(), crossing.choice, first.host, [reader(SMALL_READ)]);
    await runAgent(session(), under.choice, second.host, [reader('ok')]);

    assert.equal(count(first.events, 'compact_start'), 1);
    assert.equal(count(second.events, 'compact_start'), 0);
  });
});

const FIT_ERROR = 'stopped: the next request would exceed the context window';

test('the physical request-fit guard remains separate from compaction', async () => {
  await withThreshold('1', async () => {
    for (const [tokens, stops] of [
      [980_000, true],
      [900_000, false],
    ] as const) {
      const model = recordingModel((nth) =>
        nth === 1 ? toolResponse(nth, tokens) : textResponse('done'),
      );
      const {host, events} = fakeHost();

      await runAgent(session(), model.choice, host, [reader('ok')]);

      assert.equal(
        errors(events).includes(FIT_ERROR),
        stops,
        `${tokens} tokens with a ${MAX_OUTPUT_TOKENS} token reply`,
      );
      assert.equal(model.calls(), stops ? 1 : 2);
      assert.equal(count(events, 'compact_start'), 0);
    }
  });
});
