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
  compactionPrompt,
  compactSession,
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
