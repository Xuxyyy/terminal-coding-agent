import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {
  fakeHost,
  fakeModel,
  fakeStore,
  finishChunk,
  reasoningChunk,
  statusError,
  streamOf,
  textChunk,
  usageChunk,
} from '../fakes.js';
import type {ModelChoice} from '../../core/client.js';
import {
  compactionPrompt,
  compactSession,
  retainRecentUserPrompts,
  RETAINED_USER_PROMPT_BUDGET,
  summaryFrom,
  SUMMARY_PREFIX,
} from '../../core/compact.js';
import {
  addTask,
  createSession,
  setMeasured,
  type Session,
} from '../../core/session.js';
import {estimateMessage, estimateMessages} from '../../core/tokens.js';

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

function reasonedSummary(text: string): AsyncIterable<unknown> {
  return streamOf(
    reasoningChunk('summary continuation'),
    textChunk(text),
    finishChunk('stop'),
    usageChunk(500, 40),
  );
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

test('a compaction retains the user prompt before one summary', async () => {
  const {choice} = fakeModel(() => summaryResponse(RECAP));
  const {host} = fakeHost();
  const active = session();

  await compactSession(active, choice, host);

  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'user', content: 'rename the widget'},
    {role: 'assistant', content: SUMMARY_PREFIX + RECAP},
  ]);
});

test('a compaction keeps opaque continuation state on the summary', async () => {
  const {choice} = fakeModel(() => reasonedSummary(RECAP));
  const {host} = fakeHost();
  const active = session();

  await compactSession(active, choice, host);

  assert.deepEqual(active.messages[2], {
    role: 'assistant',
    content: SUMMARY_PREFIX + RECAP,
    reasoning_content: 'summary continuation',
  });
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
  const before = [...active.messages];

  const result = await compactSession(active, choice, host);

  assert.equal(result, null);
  assert.deepEqual(active.messages, before);
  assert.ok(active.messages.every((message, at) => message === before[at]));
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
  const seen: {
    summary: OpenAI.ChatCompletionMessageParam;
    replaced: number;
    replacement: OpenAI.ChatCompletionMessageParam[];
  }[] = [];
  const store = fakeStore({
    appendCompact(summary, replaced, replacement) {
      seen.push({summary, replaced, replacement: replacement!});
    },
  });

  await compactSession(active, choice, host, store);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.replaced, 4);
  assert.equal(seen[0]!.summary, active.messages[3]);
  assert.deepEqual(seen[0]!.replacement, active.messages.slice(1));
});

test('post-summary messages are installed once and included in token reporting', async () => {
  const {choice} = fakeModel(() => summaryResponse(RECAP));
  const {host} = fakeHost();
  const active = session();
  const pending: OpenAI.ChatCompletionMessageParam = {
    role: 'user',
    content: 'keep this pending task outside the summary',
  };
  const before = estimateMessages([...active.messages, pending]);

  const result = await compactSession(active, choice, host, undefined, [pending]);

  assert.equal(result?.before, before);
  assert.equal(result?.after, estimateMessages(active.messages));
  assert.equal(active.messages.at(-1), pending);
  assert.equal(active.messages.filter((message) => message === pending).length, 1);
  assert.deepEqual(
    active.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'user'],
  );
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
    {role: 'user', content: 'rename the widget'},
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

test('recent user prompts are retained newest-first and restored chronologically', () => {
  const first: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'first'};
  const second: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'second'};
  const third: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'third'};
  const retained = retainRecentUserPrompts([
    first,
    {role: 'assistant', content: 'reply'},
    second,
    {role: 'tool', tool_call_id: 'call-1', content: 'raw result'},
    third,
  ]);

  assert.deepEqual(retained, [first, second, third]);
  assert.equal(retained[0], first);
  assert.equal(retained[1], second);
  assert.equal(retained[2], third);
});

test('an oversized newest string prompt is cloned and truncated within 20,000 tokens', () => {
  const content = `begin-${'x'.repeat(100_000)}-newest-end`;
  const prompt: OpenAI.ChatCompletionMessageParam = {role: 'user', content};

  const retained = retainRecentUserPrompts([prompt]);

  assert.equal(retained.length, 1);
  assert.notEqual(retained[0], prompt);
  assert.equal(prompt.content, content);
  assert.match(String(retained[0]!.content), /^\[Earlier content truncated/);
  assert.match(String(retained[0]!.content), /-newest-end$/);
  assert.ok(estimateMessages(retained) <= RETAINED_USER_PROMPT_BUDGET);
  assert.ok(
    RETAINED_USER_PROMPT_BUDGET - estimateMessages(retained) < 2,
    'the truncation should use all available estimated-token space',
  );
});

test('the oldest string boundary is truncated after newer prompts are charged', () => {
  const oldest: OpenAI.ChatCompletionMessageParam = {
    role: 'user',
    content: `old-start-${'a'.repeat(100_000)}-old-end`,
  };
  const newest: OpenAI.ChatCompletionMessageParam = {
    role: 'user',
    content: 'new request',
  };

  const retained = retainRecentUserPrompts([oldest, newest]);

  assert.equal(retained.length, 2);
  assert.notEqual(retained[0], oldest);
  assert.equal(retained[1], newest);
  assert.match(String(retained[0]!.content), /-old-end$/);
  assert.ok(estimateMessages(retained) <= RETAINED_USER_PROMPT_BUDGET);
});

test('CJK prompts obey the same retained-token budget', () => {
  const prompt: OpenAI.ChatCompletionMessageParam = {
    role: 'user',
    content: `开头${'界'.repeat(25_000)}结尾`,
  };

  const retained = retainRecentUserPrompts([prompt]);

  assert.equal(retained.length, 1);
  assert.ok(estimateMessages(retained) <= RETAINED_USER_PROMPT_BUDGET);
  assert.match(String(retained[0]!.content), /结尾$/);
});

test('a string too large for even a truncation marker is skipped', () => {
  const older: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'x'};
  const oversized: OpenAI.ChatCompletionMessageParam = {
    role: 'user',
    content: 'y'.repeat(100),
  };
  const newest: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'newest'};

  const retained = retainRecentUserPrompts([older, oversized, newest], 11);

  assert.deepEqual(retained, [older, newest]);
});

test('structured user prompts are retained whole or skipped', () => {
  const older: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'older'};
  const structured = {
    role: 'user',
    content: [{type: 'text', text: '界'.repeat(25_000)}],
  } as OpenAI.ChatCompletionMessageParam;
  const newest: OpenAI.ChatCompletionMessageParam = {role: 'user', content: 'newest'};

  const retained = retainRecentUserPrompts([older, structured, newest]);

  assert.deepEqual(retained, [older, newest]);
  assert.equal(retained.some((message) => message === structured), false);
  assert.ok(estimateMessages(retained) <= RETAINED_USER_PROMPT_BUDGET);
  assert.ok(estimateMessage(structured) > RETAINED_USER_PROMPT_BUDGET);
});
