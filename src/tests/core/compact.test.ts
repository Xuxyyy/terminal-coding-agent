import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
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
import {
  AUTO_COMPACT_AT,
  compactionPrompt,
  compactMidRun,
  compactSession,
  compactThreshold,
  shouldCompact,
  SUMMARY_PREFIX,
} from '../../core/compact.js';
import {addTask, createSession, type Session} from '../../core/session.js';

type Body = OpenAI.ChatCompletionCreateParams;

function session(): Session {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  addTask(active, 'rename the widget');
  active.messages.push({role: 'assistant', content: 'renamed it'});
  return active;
}

function summaryTurn(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(500, 40));
}

function recordingModel(reply: () => AsyncIterable<unknown>): {
  choice: ModelChoice;
  bodies: Body[];
} {
  const bodies: Body[] = [];
  const create = async (body: Body): Promise<unknown> => {
    bodies.push(body);
    return reply();
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-model',
      label: 'Fake',
      contextWindow: 1_000,
    },
    bodies,
  };
}

test('the summarizing request carries no tools', async () => {
  const {choice, bodies} = recordingModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();

  await compactSession(session(), choice, host);

  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.deepEqual(body.tools, []);
  assert.deepEqual(body.messages[body.messages.length - 1], {
    role: 'user',
    content: compactionPrompt(),
  });
});

test('a compaction leaves the system message and one summary', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();

  await compactSession(active, choice, host);

  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: `${SUMMARY_PREFIX}a short recap`},
  ]);
});

test('a compaction clears the measured context size', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();
  active.lastContextTokens = 4_000;

  await compactSession(active, choice, host);

  assert.equal(active.lastContextTokens, 0);
});

test('a failed summary leaves the conversation alone', async () => {
  const {choice} = fakeModel(() => statusError(400));
  const {host} = fakeHost();
  const active = session();
  const before = structuredClone(active.messages);

  const result = await compactSession(active, choice, host);

  assert.equal(result, null);
  assert.deepEqual(active.messages, before);
});

test('an empty summary is not written to the store', async () => {
  const {choice} = fakeModel(() => summaryTurn('   \n  '));
  const {host} = fakeHost();
  const active = session();
  const before = structuredClone(active.messages);
  let compacts = 0;
  const store = fakeStore({
    appendCompact() {
      compacts += 1;
    },
  });

  const result = await compactSession(active, choice, host, store);

  assert.equal(result, null);
  assert.deepEqual(active.messages, before);
  assert.equal(compacts, 0);
});

test('the store is told how many messages the summary replaced', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();
  addTask(active, 'now rename the gadget');
  active.messages.push({role: 'assistant', content: 'renamed that too'});
  const seen: {summary: OpenAI.ChatCompletionMessageParam; replaced: number}[] =
    [];
  const store = fakeStore({
    appendCompact(summary, replaced) {
      seen.push({summary, replaced});
    },
  });

  await compactSession(active, choice, host, store);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.replaced, 4);
  assert.equal(seen[0]!.summary, active.messages[1]);
});

test('the threshold is 0.8 unless the environment overrides it', () => {
  assert.equal(compactThreshold({}), AUTO_COMPACT_AT);
  assert.equal(compactThreshold({ACC_COMPACT_AT: '0.5'}), 0.5);
  assert.equal(compactThreshold({ACC_COMPACT_AT: '1'}), 1);
});

test('an override that is not a fraction is ignored', () => {
  for (const raw of ['', 'abc', '0', '-1', '2']) {
    assert.equal(compactThreshold({ACC_COMPACT_AT: raw}), AUTO_COMPACT_AT, raw);
  }
});

function measured(tokens: number): Session {
  const active = createSession(process.cwd(), 'rules', 1_000);
  active.lastContextTokens = tokens;
  return active;
}

test('compacting starts at the threshold, not before it', () => {
  assert.equal(shouldCompact(measured(0), {}), false);
  assert.equal(shouldCompact(measured(799), {}), false);
  assert.equal(shouldCompact(measured(800), {}), true);
  assert.equal(shouldCompact(measured(950), {}), true);
});

test('a low override moves the line down', () => {
  assert.equal(shouldCompact(measured(150), {ACC_COMPACT_AT: '0.1'}), true);
  assert.equal(shouldCompact(measured(99), {ACC_COMPACT_AT: '0.1'}), false);
});

test('a mid-run compaction carries the task past the summary', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();
  addTask(active, 'now rename the gadget');
  active.messages.push({role: 'assistant', content: 'renamed that too'});

  await compactMidRun(active, choice, host);

  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: `${SUMMARY_PREFIX}a short recap`},
    {role: 'user', content: 'now rename the gadget'},
  ]);
});

test('a mid-run compaction brackets itself with events and streams nothing', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host, events} = fakeHost();

  const result = await compactMidRun(session(), choice, host);

  assert.deepEqual(
    events.map((event) => event.type),
    ['compact_start', 'compact_end'],
  );
  const end = events[1] as {replaced: number; before: number; after: number};
  assert.equal(end.replaced, result!.replaced);
  assert.equal(end.before, result!.before);
  assert.equal(end.after, result!.after);
});

test('the carried task is written after the compact record', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();
  const order: string[] = [];
  const carried: OpenAI.ChatCompletionMessageParam[] = [];
  const store = fakeStore({
    appendCompact() {
      order.push('compact');
    },
    appendMessage(message) {
      order.push('message');
      carried.push(message);
      return 'id';
    },
  });

  await compactMidRun(active, choice, host, store);

  assert.deepEqual(order, ['compact', 'message']);
  assert.equal(carried.length, 1);
  assert.equal(carried[0], active.messages[2]);
});

test('the summarizing call is billed but is not the new context size', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = session();
  active.lastContextTokens = 900;
  const before = active.usage.total;

  await compactMidRun(active, choice, host);

  assert.equal(active.usage.total, before + 540);
  assert.equal(active.usage.prompt, 500);
  assert.equal(active.usage.completion, 40);
  assert.equal(active.lastContextTokens, 0);
});

test('a failed mid-run compaction leaves the conversation alone', async () => {
  const {choice} = fakeModel(() => statusError(400));
  const {host, events} = fakeHost();
  const active = session();
  const before = structuredClone(active.messages);

  const result = await compactMidRun(active, choice, host);

  assert.equal(result, null);
  assert.deepEqual(active.messages, before);
  assert.deepEqual(
    events.map((event) => event.type),
    ['compact_start'],
  );
});

test('a conversation with no task carries nothing', async () => {
  const {choice} = fakeModel(() => summaryTurn('a short recap'));
  const {host} = fakeHost();
  const active = createSession(process.cwd(), 'rules', 1_000);
  active.messages.push({role: 'assistant', content: 'nothing was asked'});
  let messages = 0;
  const store = fakeStore({
    appendMessage() {
      messages += 1;
      return 'id';
    },
  });

  await compactMidRun(active, choice, host, store);

  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: `${SUMMARY_PREFIX}a short recap`},
  ]);
  assert.equal(messages, 0);
});
