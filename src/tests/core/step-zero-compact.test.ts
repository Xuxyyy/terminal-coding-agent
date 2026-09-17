import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  fakeHost,
  fakeModel,
  fakeStore,
  finishChunk,
  statusError,
  streamOf,
  textChunk,
  usageChunk,
} from '../fakes.js';
import type {ModelChoice} from '../../core/client.js';
import {compactionPrompt, SUMMARY_PREFIX} from '../../core/compact.js';
import type {AgentEvent} from '../../core/host.js';
import {runAgent} from '../../core/loop.js';
import {
  addTask,
  createSession,
  setMeasured,
  type Session,
} from '../../core/session.js';
import type {Tool} from '../../core/tools/registry.js';

type Message = OpenAI.ChatCompletionMessageParam;

const TASK = 'rename the widget';
const STORY =
  'The user asked for a rename and it is done. No file is left open and ' +
  'nothing else is pending in the workspace right now, so the task is complete.';

const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
  async run() {
    return {text: 'ok'};
  },
};

function textResponse(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(10, 2));
}

function emptyResponse(): AsyncIterable<unknown> {
  return streamOf(finishChunk('stop'), usageChunk(10, 0));
}

function session(): Session {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  addTask(active, TASK);
  return active;
}

function measured(tokens: number): Session {
  const active = session();
  setMeasured(active, tokens);
  return active;
}

function recordingModel(next: (nth: number) => unknown): {
  choice: ModelChoice;
  calls: () => number;
  sent: () => Message[][];
} {
  let nth = 0;
  const sent: Message[][] = [];
  const create = async (body: unknown): Promise<unknown> => {
    nth += 1;
    sent.push([...((body as {messages?: Message[]}).messages ?? [])]);
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
    sent: () => sent,
  };
}

function count(events: AgentEvent[], type: AgentEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

function streamed(events: AgentEvent[]): string {
  return events
    .flatMap((event) => (event.type === 'text_delta' ? [event.text] : []))
    .join('');
}

test('a pending user task counts toward the step-zero threshold', async () => {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  active.messages.push({role: 'assistant', content: STORY});
  setMeasured(active, 799_990);
  addTask(active, 'x'.repeat(1_000));
  const {choice, calls} = fakeModel((nth) =>
    nth === 1 ? textResponse(STORY) : textResponse('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(count(events, 'compact_start'), 1);
});

test('the summarizer excludes the pending task and restores the same object', async () => {
  const model = recordingModel((nth) =>
    nth === 1 ? textResponse(STORY) : textResponse('done'),
  );
  const {host} = fakeHost();
  const active = measured(850_000);
  const task = active.messages.at(-1)!;

  await runAgent(active, model.choice, host, [noop]);

  const summarizer = model.sent()[0]!;
  assert.equal(summarizer.at(-1)?.content, compactionPrompt());
  assert.equal(
    summarizer.some((message) => message === task || message.content === TASK),
    false,
  );
  assert.ok(model.sent()[1]!.some((message) => message === task));
  assert.equal(active.messages[1]?.content, SUMMARY_PREFIX + STORY);
  assert.equal(active.messages[2], task);
});

test('the automatic summary is hidden and the same run continues', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1 ? textResponse(STORY) : textResponse('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(measured(850_000), choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(streamed(events), 'done');
  assert.equal(count(events, 'compact_start'), 1);
  assert.equal(count(events, 'compact_end'), 1);
  assert.equal(count(events, 'turn_end'), 1);
});

test('a session past the physical window compacts before the request', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1 ? textResponse(STORY) : textResponse('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(measured(1_200_000), choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(count(events, 'compact_start'), 1);
  assert.deepEqual(errors(events), []);
});

test('step zero below the line does not compact', async () => {
  const {choice, calls} = fakeModel(() => textResponse('done'));
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 1);
  assert.equal(count(events, 'compact_start'), 0);
});

test('two rejected summaries preserve history and stop the run', async () => {
  const model = recordingModel(() => emptyResponse());
  const {host, events} = fakeHost();
  const active = measured(850_000);
  const original = [...active.messages];
  let compactRecords = 0;
  const store = fakeStore({
    appendCompact() {
      compactRecords += 1;
    },
  });

  await runAgent(active, model.choice, host, [noop], store);

  assert.equal(model.calls(), 2);
  assert.equal(compactRecords, 0);
  assert.deepEqual(active.messages, original);
  assert.ok(active.messages.every((message, index) => message === original[index]));
  assert.deepEqual(errors(events), ['could not compact; the run stopped']);
  assert.equal(count(events, 'compact_start'), 1);
  assert.equal(count(events, 'compact_end'), 1);
  assert.equal(count(events, 'turn_end'), 1);
});

test('a summary transport failure restores the task and sends no normal request', async () => {
  const model = recordingModel(() => statusError(503));
  const {host, events} = fakeHost();
  const active = measured(850_000);
  const original = [...active.messages];

  await runAgent(active, model.choice, host, [noop]);

  assert.ok(model.calls() >= 1);
  assert.ok(
    model.sent().every((messages) => messages.at(-1)?.content === compactionPrompt()),
    'transport retries must all remain compaction requests',
  );
  assert.deepEqual(active.messages, original);
  assert.ok(active.messages.every((message, index) => message === original[index]));
  assert.deepEqual(errors(events), ['could not compact; the run stopped']);
  assert.equal(count(events, 'compact_end'), 1);
  assert.equal(count(events, 'turn_end'), 1);
});
