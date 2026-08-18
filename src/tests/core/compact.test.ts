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
  summaryFrom,
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

const RECAP =
  'The user asked for the widget to be renamed. The rename is done and no ' +
  'file is still open. Nothing else is left to do in src/widget.ts.';

const DSML =
  '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read_file">\n' +
  '<｜｜DSML｜｜parameter name="path" string="true">three.md</｜｜DSML｜｜parameter>\n' +
  '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';

function summaryResponse(text: string): AsyncIterable<unknown> {
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
  const {choice, bodies} = recordingModel(() => summaryResponse(RECAP));
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
  const {choice} = fakeModel(() => summaryResponse(RECAP));
  const {host} = fakeHost();
  const active = session();

  await compactSession(active, choice, host);

  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: SUMMARY_PREFIX + RECAP},
  ]);
});

test('a compaction clears the measured context size', async () => {
  const {choice} = fakeModel(() => summaryResponse(RECAP));
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
  const {choice} = fakeModel(() => summaryResponse('   \n  '));
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
  const {choice} = fakeModel(() => summaryResponse(RECAP));
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

test('tool-call markup is not a summary', () => {
  assert.equal(summaryFrom(DSML), null);
});

test('a reply too short to be a summary is refused', () => {
  assert.equal(summaryFrom('Sure, I can help with that.'), null);
});

test('prose long enough to be a summary is kept, trimmed', () => {
  assert.equal(summaryFrom(`\n  ${RECAP}  \n`), RECAP);
});

test('a summary of tool-call markup leaves the conversation alone', async () => {
  const {choice, bodies} = recordingModel(() => summaryResponse(DSML));
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
  assert.equal(bodies.length, 2);
});

test('a rejected summary is asked for once more', async () => {
  const texts = [DSML, RECAP];
  let at = 0;
  const {choice, bodies} = recordingModel(() => summaryResponse(texts[at++]!));
  const {host} = fakeHost();
  const active = session();

  const result = await compactSession(active, choice, host);

  assert.equal(result?.summary, RECAP);
  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: SUMMARY_PREFIX + RECAP},
  ]);
  assert.equal(bodies.length, 2);
});

test('the second ask tells the model to reply with prose only', async () => {
  const texts = [DSML, RECAP];
  let at = 0;
  const {choice, bodies} = recordingModel(() => summaryResponse(texts[at++]!));
  const {host} = fakeHost();

  await compactSession(session(), choice, host);

  const asks = bodies.map((body) => body.messages[body.messages.length - 1]);
  assert.deepEqual(asks[0], {role: 'user', content: compactionPrompt()});
  assert.deepEqual(asks[1], {role: 'user', content: compactionPrompt(true)});
});

test('the usage of every attempt is reported', async () => {
  const texts = [DSML, RECAP];
  let at = 0;
  const {choice} = recordingModel(() => summaryResponse(texts[at++]!));
  const {host} = fakeHost();

  const result = await compactSession(session(), choice, host);

  assert.equal(result?.usage.prompt, 1_000);
  assert.equal(result?.usage.completion, 80);
});
