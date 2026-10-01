import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {ModelChoice} from '../../../core/client.js';
import {runHeadless} from '../../../core/headless/run.js';
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
}) {
  return runHeadless({
    root: options.root,
    task: 'do the thing',
    choice: options.choice,
    policy: options.policy ?? 'deny',
    maxSeconds: options.maxSeconds ?? 30,
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

test('print mode stops at the thirty-step gate even under yes', async () => {
  const {choice, calls} = fakeModel((nth) => callResponse('read_file', {path: 'note.txt'}));
  const work = tempDir();
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');

  const result = await headless({root: work, choice, policy: 'yes'});

  assert.equal(calls(), 30);
  assert.equal(result.stopped, 'denied');
  assert.deepEqual(
    result.prompts.map((prompt) => [
      prompt.request.command,
      prompt.request.suppressible,
      prompt.decision,
    ]),
    [['continue', false, 'deny']],
  );
});
