import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  fakeHost,
  fakeModel,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import {CLEARED_READ} from '../../core/clear.js';
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

const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
  async run() {
    return {text: 'ok'};
  },
};

function textTurn(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(10, 2));
}

function emptyTurn(): AsyncIterable<unknown> {
  return streamOf(finishChunk('stop'), usageChunk(10, 0));
}

function toolTurn(n: number, total: number): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${n}`, 'noop', '{}'),
    finishChunk('tool_calls'),
    usageChunk(total - 2, 2),
  );
}

function readRound(id: string, path: string, body: string): Message[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: {name: 'read_file', arguments: JSON.stringify({path})},
        },
      ],
    },
    {role: 'tool', tool_call_id: id, content: body},
  ];
}

function session(...extra: Message[]): Session {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  active.messages.push(...extra);
  addTask(active, TASK);
  return active;
}

function measured(tokens: number, ...extra: Message[]): Session {
  const active = session(...extra);
  setMeasured(active, tokens);
  return active;
}

function compacted(events: AgentEvent[]): boolean {
  return events.some((event) => event.type === 'compact_start');
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

function recordingModel(next: (turn: number) => unknown): {
  choice: ModelChoice;
  sent: () => Message[][];
} {
  let turn = 0;
  const sent: Message[][] = [];
  const create = async (body: unknown): Promise<unknown> => {
    turn += 1;
    sent.push([...((body as {messages?: Message[]}).messages ?? [])]);
    return next(turn);
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-model',
      label: 'Fake',
      contextWindow: 1_000_000,
    },
    sent: () => sent,
  };
}

test('the summarizer is never shown the pending task', async () => {
  const {choice, sent} = recordingModel((turn) =>
    turn === 1 ? textTurn('the story so far') : textTurn('done'),
  );
  const {host} = fakeHost();

  await runAgent(measured(850_000), choice, host, [noop]);

  const summarizer = sent()[0];
  assert.equal(
    summarizer[summarizer.length - 1]?.content,
    compactionPrompt(),
    'the instruction must be the last thing the summarizer sees',
  );
  assert.equal(
    summarizer.filter((message) => message.content === TASK).length,
    0,
    'the task must be out of the list while the summary is written',
  );
  assert.ok(
    sent()[1]?.some((message) => message.content === TASK),
    'the task must be back for the run itself',
  );
});

test('turn 0 over the line compacts and keeps the task last', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? textTurn('the story so far') : textTurn('done'),
  );
  const {host, events} = fakeHost();
  const active = measured(850_000);
  const task = active.messages[active.messages.length - 1];

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.ok(compacted(events));
  assert.equal(
    active.messages[1].content,
    `${SUMMARY_PREFIX}the story so far`,
  );
  assert.equal(active.messages[2], task);
  assert.equal(errors(events).length, 0);
});

test('the summary never streams into the transcript', async () => {
  const {choice} = fakeModel((turn) =>
    turn === 1 ? textTurn('the story so far') : textTurn('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(measured(850_000), choice, host, [noop]);

  assert.equal(streamed(events), 'done');
});

test('a session past the window compacts instead of stopping', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? textTurn('the story so far') : textTurn('done'),
  );
  const {host, events} = fakeHost();

  await runAgent(measured(1_200_000), choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.ok(compacted(events));
  assert.equal(errors(events).length, 0);
});

test('turn 0 compacts when clearing was exhausted, even under the line', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? textTurn('the story so far') : textTurn('done'),
  );
  const {host, events} = fakeHost();
  const active = session();
  active.clearingExhausted = true;

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.ok(compacted(events));
  assert.equal(active.clearingExhausted, false);
});

test('turn 0 under the line with nothing exhausted does not compact', async () => {
  const {choice, calls} = fakeModel(() => textTurn('done'));
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 1);
  assert.equal(compacted(events), false);
});

test('clearing runs first, and a session it saves is never summarized', async () => {
  const {choice, calls} = fakeModel(() => textTurn('done'));
  const {host, events} = fakeHost();
  const active = measured(
    850_000,
    ...readRound('r1', 'a.ts', 'a'.repeat(400_000)),
    ...readRound('r2', 'b.ts', 'small'),
  );

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 1);
  assert.equal(compacted(events), false);
  assert.equal(active.messages[2].content, CLEARED_READ);
});

test('a failed summary is reported and the run continues', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? emptyTurn() : textTurn('done'),
  );
  const {host, events} = fakeHost();
  const active = measured(850_000);

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.deepEqual(errors(events), ['could not compact; the run continues']);
  assert.equal(active.messages[1].content, TASK);
  assert.ok(events.some((event) => event.type === 'compact_end'));
});

test('the summarizer is never called once a run is in flight', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn <= 2 ? toolTurn(turn, 902_000) : textTurn('done'),
  );
  const {host, events} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 3);
  assert.equal(compacted(events), false);
  assert.equal(
    active.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith(SUMMARY_PREFIX),
    ),
    false,
  );
});
