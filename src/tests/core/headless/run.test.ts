import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {ModelChoice} from '../../../core/client.js';
import {runHeadless} from '../../../core/headless/run.js';
import {systemPrompt} from '../../../core/prompt.js';
import {loadSettings, settingsFiles} from '../../../core/settings.js';
import {toolsFor, toolDefinitions} from '../../../core/tools/index.js';
import type {HeadlessPolicy} from '../../../core/headless/host.js';
import {
  fakeModel,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../../fakes.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-headless-'));
}

function callResponse(
  name: string,
  args: unknown,
  prompt = 10,
  completion = 2,
): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${name}`, name, JSON.stringify(args)),
    finishChunk('tool_calls'),
    usageChunk(prompt, completion),
  );
}

function textResponse(
  parts: string[],
  prompt = 10,
  completion = 2,
): AsyncIterable<unknown> {
  return streamOf(
    ...parts.map((part) => textChunk(part)),
    finishChunk('stop'),
    usageChunk(prompt, completion),
  );
}

function headless(options: {
  root: string;
  choice: ModelChoice;
  policy?: HeadlessPolicy;
  maxSeconds?: number;
  maxSteps?: number;
}) {
  return runHeadless({
    root: options.root,
    task: 'do the thing',
    choice: options.choice,
    policy: options.policy ?? 'deny',
    maxSeconds: options.maxSeconds ?? 30,
    maxSteps: options.maxSteps,
  });
}

test('an answer with no tool call finishes and returns the deltas joined', async () => {
  const {choice} = fakeModel(() => textResponse(['one ', 'two ', 'three']));

  const result = await headless({root: tempDir(), choice});

  assert.equal(result.stopped, 'done');
  assert.equal(result.text, 'one two three');
  assert.deepEqual(result.prompts, []);
  assert.equal(result.error, undefined);
});

test('headless startup uses auto by default and preserves saved permission modes', async () => {
  const previousHome = process.env.ACC_HOME;
  try {
    for (const saved of [undefined, 'ask-edits', 'auto-edits', 'auto'] as const) {
      const root = tempDir();
      const home = tempDir();
      process.env.ACC_HOME = home;
      if (saved) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({permission_mode: saved}));
      loadSettings(settingsFiles(root));
      let request: {messages: {content: string}[]; tools: unknown} | undefined;
      const {choice} = fakeModel((_nth, body) => {
        request = body as typeof request;
        return textResponse(['done']);
      });

      const result = await headless({root, choice});

      assert.equal(result.stopped, 'done');
      const mode = saved ?? 'auto';
      assert.ok(request?.messages[0]?.content.startsWith(systemPrompt(root, mode)));
      assert.match(request!.messages[0]!.content, /at most 60 model turns, including the final answer/);
      assert.deepEqual(request?.tools, toolDefinitions(toolsFor(mode)));
      assert.equal(fs.existsSync(path.join(home, 'settings.json')), saved !== undefined);
    }
  } finally {
    if (previousHome === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = previousHome;
    loadSettings([]);
  }
});

test('a refused command stops the run as denied and is written down', async () => {
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'keep me\n');
  const {choice} = fakeModel((nth) =>
    nth === 1
      ? callResponse('bash', {command: 'rm -rf note.txt'})
      : textResponse(['could not delete it']),
  );

  const result = await headless({root: work, choice, policy: 'deny'});

  assert.equal(result.stopped, 'denied');
  assert.deepEqual(
    result.prompts.map((prompt) => [prompt.request.command, prompt.decision]),
    [['rm -rf note.txt', 'deny']],
  );
  assert.equal(fs.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'keep me\n');
});

test('no time at all stops before the model is ever called', async () => {
  const {choice, calls} = fakeModel(() => textResponse(['never sent']));

  const result = await headless({root: tempDir(), choice, maxSeconds: 0});

  assert.equal(result.stopped, 'timeout');
  assert.equal(calls(), 0);
  assert.equal(result.text, '');
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.usage, {prompt: 0, completion: 0, total: 0});
  assert.deepEqual(result.tokenUsage, {
    requests: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
    },
  });
});

test('usage records every request and adds up provider totals', async () => {
  const {choice} = fakeModel((nth) =>
    nth === 1
      ? streamOf(
          toolCallChunk(
            'call-write_file',
            'write_file',
            JSON.stringify({path: 'note.txt', content: 'two\n'}),
          ),
          finishChunk('tool_calls'),
          usageChunk(10, 2, 4, 6),
        )
      : streamOf(
          textChunk('wrote it'),
          finishChunk('stop'),
          usageChunk(30, 5, 20, 10),
        ),
  );

  const result = await headless({root: tempDir(), choice, policy: 'yes'});

  assert.deepEqual(result.usage, {prompt: 40, completion: 7, total: 47});
  assert.deepEqual(result.tokenUsage, {
    requests: [
      {
        request: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheHitInputTokens: 4,
        cacheMissInputTokens: 6,
      },
      {
        request: 2,
        inputTokens: 30,
        outputTokens: 5,
        totalTokens: 35,
        cacheHitInputTokens: 20,
        cacheMissInputTokens: 10,
      },
    ],
    totals: {
      inputTokens: 40,
      outputTokens: 7,
      totalTokens: 47,
      cacheHitInputTokens: 24,
      cacheMissInputTokens: 16,
    },
  });
});

test('every event of the run is kept in the order it was emitted', async () => {
  const work = tempDir();
  const {choice} = fakeModel((nth) =>
    nth === 1
      ? callResponse('write_file', {path: 'note.txt', content: 'two\n'})
      : textResponse(['wrote ', 'it']),
  );

  const result = await headless({root: work, choice, policy: 'yes'});

  assert.deepEqual(
    result.events.map((event) => event.type),
    ['tool_start', 'tool_end', 'text_delta', 'text_delta', 'turn_end'],
  );
  assert.equal(fs.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'two\n');
});

test('print mode defaults to sixty turns and reports budget exhaustion', async () => {
  const {choice, calls} = fakeModel((nth) => callResponse('read_file', {path: 'note.txt'}));
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');

  const result = await headless({root: work, choice, policy: 'yes'});

  assert.equal(calls(), 60);
  assert.equal(result.stopped, 'step_limit');
  assert.deepEqual(result.prompts, []);
  assert.match(result.error!, /step budget exhausted/);
});

test('a larger headless budget finishes beyond sixty turns under either policy', async () => {
  for (const policy of ['deny', 'yes'] as const) {
    const work = tempDir();
    fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
    const sent: string[] = [];
    const {choice, calls} = fakeModel((nth, body) => {
      sent.push((body as {messages: {content: string}[]}).messages[0]!.content);
      return nth < 82 ? callResponse('read_file', {path: 'note.txt'}) : textResponse(['finished']);
    });

    const result = await headless({root: work, choice, policy, maxSteps: 90});

    assert.equal(calls(), 82);
    assert.equal(result.stopped, 'done');
    assert.equal(result.text, 'finished');
    assert.deepEqual(result.prompts, []);
    assert.match(sent[0]!, /at most 90 model turns/);
    assert.match(sent[80]!, /10 model turns remain/);
  }
});

test('a custom budget stops exactly at its limit and preserves usage', async () => {
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
  const sent: string[] = [];
  const {choice, calls} = fakeModel((_nth, body) => {
    sent.push((body as {messages: {content: string}[]}).messages[0]!.content);
    return callResponse('read_file', {path: 'note.txt'});
  });

  const result = await headless({root: work, choice, maxSteps: 37});

  assert.equal(calls(), 37);
  assert.match(sent[10]!, /10 model turns completed.*27 model turns remain.*turn 37/);
  assert.match(sent[27]!, /27 model turns completed.*10 model turns remain.*turn 37/);
  assert.match(sent[30]!, /30 model turns completed.*7 model turns remain.*turn 37/);
  assert.equal(result.stopped, 'step_limit');
  assert.deepEqual(result.prompts, []);
  assert.deepEqual(result.usage, {prompt: 370, completion: 74, total: 444});
});

test('the final answer can use the last permitted turn', async () => {
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
  const {choice, calls} = fakeModel((nth) => nth < 3
    ? callResponse('read_file', {path: 'note.txt'}) : textResponse(['done']));

  const result = await headless({root: work, choice, maxSteps: 3});

  assert.equal(calls(), 3);
  assert.equal(result.stopped, 'done');
});

test('the budget counts model turns rather than individual tool calls', async () => {
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
  const {choice, calls} = fakeModel(() => streamOf(
    toolCallChunk('first', 'read_file', JSON.stringify({path: 'note.txt'}), 0),
    toolCallChunk('second', 'read_file', JSON.stringify({path: 'note.txt'}), 1),
    finishChunk('tool_calls'), usageChunk(10, 2),
  ));

  const result = await headless({root: work, choice, maxSteps: 2});

  assert.equal(calls(), 2);
  assert.equal(result.stopped, 'step_limit');
  assert.equal(result.events.filter((event) => event.type === 'tool_start').length, 4);
});

test('invalid programmatic budgets are rejected before model calls', async () => {
  const {choice, calls} = fakeModel(() => textResponse(['never sent']));
  for (const maxSteps of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(headless({root: tempDir(), choice, maxSteps}), /positive safe integer/);
  }
  assert.equal(calls(), 0);
});

test('tool permissions still apply after passing turn sixty', async () => {
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'keep me\n');
  const {choice} = fakeModel((nth) => {
    if (nth <= 60) return callResponse('read_file', {path: 'note.txt'});
    if (nth === 61) return callResponse('bash', {command: 'rm -rf note.txt'});
    return textResponse(['could not delete it']);
  });

  const result = await headless({root: work, choice, maxSteps: 90, policy: 'deny'});

  assert.equal(result.stopped, 'denied');
  assert.deepEqual(result.prompts.map((prompt) => [prompt.request.command, prompt.decision]),
    [['rm -rf note.txt', 'deny']]);
  assert.equal(fs.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'keep me\n');
});

test('the selected step budget does not override the time limit', async () => {
  const {choice, calls} = fakeModel(() => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield textChunk('late answer');
      yield finishChunk('stop');
      yield usageChunk(10, 2);
    },
  }));

  const result = await headless({root: tempDir(), choice, maxSteps: 60, maxSeconds: 0.01});

  assert.equal(calls(), 1);
  assert.equal(result.stopped, 'timeout');
});
