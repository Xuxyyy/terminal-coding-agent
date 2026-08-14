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
  compactSession,
  compactThreshold,
  shouldCompact,
  SUMMARY_PREFIX,
} from '../../core/compact.js';
import {
  addTask,
  createSession,
  setMeasured,
  type Session,
} from '../../core/session.js';

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
  setMeasured(active, 4_000);

  await compactSession(active, choice, host);

  assert.equal(active.lastContextTokens, 0);
  assert.equal(active.measuredAt, 0);
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
  setMeasured(active, tokens);
  return active;
}

test('compacting starts at the threshold, not before it', () => {
  assert.equal(shouldCompact(measured(0), {}), false);
  assert.equal(shouldCompact(measured(799), {}), false);
  assert.equal(shouldCompact(measured(800), {}), true);
  assert.equal(shouldCompact(measured(950), {}), true);
});

test('tool results pushed since the measurement count against the line', () => {
  const active = measured(700);
  assert.equal(shouldCompact(active, {}), false);

  active.messages.push({
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'x'.repeat(4_000),
  });

  assert.equal(shouldCompact(active, {}), true);
});

test('an emptied result puts the session back under the line', () => {
  const active = measured(700);
  const result = {
    role: 'tool' as const,
    tool_call_id: 'call-1',
    content: 'x'.repeat(4_000),
  };
  active.messages.push(result);
  setMeasured(active, 1_700);
  assert.equal(shouldCompact(active, {}), true);

  result.content = '';

  assert.equal(shouldCompact(active, {}), false);
});

test('a low override moves the line down', () => {
  assert.equal(shouldCompact(measured(150), {ACC_COMPACT_AT: '0.1'}), true);
  assert.equal(shouldCompact(measured(99), {ACC_COMPACT_AT: '0.1'}), false);
});
