import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import type {AgentEvent} from '../../core/host.js';
import type {RecordedPrompt} from '../../core/headless/host.js';
import {
  metricsOf,
  RESULT_LIMIT,
  TOOL_ERROR_PREFIX,
  transcriptOf,
} from './metrics.js';

function call(
  id: string,
  name: string,
  args: unknown,
  result: string,
): AgentEvent[] {
  return [
    {type: 'tool_start', id, name, args},
    {type: 'tool_end', id, name, result, diff: null},
  ];
}

function prompt(command: string): RecordedPrompt {
  return {
    request: {command, reason: 'writes a file', suppressible: true},
    decision: 'once',
  };
}

test('a run with no tool calls counts no steps, no calls, and no errors', () => {
  assert.deepEqual(metricsOf([], []), {
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokens: 0,
    prompts: 0,
  });
});

test('two clean tool calls count as two calls and no errors', () => {
  const metrics = metricsOf(
    [
      ...call('1', 'read', {path: 'a.ts'}, 'the file'),
      ...call('2', 'write', {path: 'b.ts'}, 'wrote 3 lines'),
    ],
    [],
  );

  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.toolErrors, 0);
});

test('a result starting with the error prefix is an error and is still a call', () => {
  const metrics = metricsOf(
    [
      ...call('1', 'read', {path: 'a.ts'}, 'the file'),
      ...call('2', 'read', {path: 'gone.ts'}, `${TOOL_ERROR_PREFIX}no such file`),
      ...call('3', 'write', {path: 'b.ts'}, 'wrote 3 lines'),
    ],
    [],
  );

  assert.equal(metrics.toolErrors, 1);
  assert.equal(metrics.toolCalls, 3);
});

test('the error prefix is only recognised at the start of a result', () => {
  const metrics = metricsOf(
    call('1', 'bash', {command: 'npm test'}, `all green, no Error: was raised`),
    [],
  );

  assert.equal(metrics.toolErrors, 0);
  assert.equal(metrics.toolCalls, 1);
});

test('steps is the same number as tool calls', () => {
  const metrics = metricsOf(
    [
      ...call('1', 'read', {}, 'the file'),
      ...call('2', 'read', {}, `${TOOL_ERROR_PREFIX}no such file`),
      ...call('3', 'write', {}, 'wrote 3 lines'),
    ],
    [prompt('write b.ts')],
  );

  assert.equal(metrics.steps, metrics.toolCalls);
  assert.equal(metrics.steps, 3);
});

test('tokens is read off the turn_end usage total, and is zero without one', () => {
  const events: AgentEvent[] = [
    {type: 'text_delta', text: 'done'},
    ...call('1', 'read', {}, 'the file'),
  ];

  assert.equal(metricsOf(events, []).tokens, 0);
  assert.equal(
    metricsOf(
      [...events, {type: 'turn_end', usage: {prompt: 90, completion: 30, total: 120}}],
      [],
    ).tokens,
    120,
  );
});

test('a later turn_end replaces the tokens of an earlier one', () => {
  const metrics = metricsOf(
    [
      {type: 'turn_end', usage: {prompt: 10, completion: 5, total: 15}},
      ...call('1', 'read', {}, 'the file'),
      {type: 'turn_end', usage: {prompt: 60, completion: 40, total: 100}},
    ],
    [],
  );

  assert.equal(metrics.tokens, 100);
});

test('prompts is the number of recorded prompts', () => {
  const metrics = metricsOf(call('1', 'write', {}, 'wrote 3 lines'), [
    prompt('write a.ts'),
    prompt('write b.ts'),
    prompt('rm -rf /'),
  ]);

  assert.equal(metrics.prompts, 3);
});

test('the transcript joins every text delta in order', () => {
  const transcript = transcriptOf([
    {type: 'text_delta', text: 'I will '},
    ...call('1', 'read', {}, 'the file'),
    {type: 'text_delta', text: 'read '},
    {type: 'turn_end', usage: {prompt: 1, completion: 1, total: 2}},
    {type: 'text_delta', text: 'the file.'},
  ]);

  assert.equal(transcript.text, 'I will read the file.');
});

test('each call takes its name and args from the tool_start with the same id', () => {
  const transcript = transcriptOf([
    {type: 'tool_start', id: 'a', name: 'read', args: {path: 'a.ts'}},
    {type: 'tool_start', id: 'b', name: 'write', args: {path: 'b.ts'}},
    {type: 'tool_end', id: 'a', name: 'read', result: 'the file', diff: null},
    {type: 'tool_end', id: 'b', name: 'write', result: 'wrote 3 lines', diff: null},
  ]);

  assert.deepEqual(transcript.calls, [
    {name: 'read', args: {path: 'a.ts'}, result: 'the file'},
    {name: 'write', args: {path: 'b.ts'}, result: 'wrote 3 lines'},
  ]);
});

test('a result longer than the limit is cut and says how many chars were dropped', () => {
  const short = 'y'.repeat(RESULT_LIMIT);
  const transcript = transcriptOf([
    ...call('1', 'bash', {command: 'cat big'}, 'x'.repeat(RESULT_LIMIT + 42)),
    ...call('2', 'bash', {command: 'cat small'}, short),
  ]);

  assert.deepEqual(transcript.calls, [
    {
      name: 'bash',
      args: {command: 'cat big'},
      result: `${'x'.repeat(RESULT_LIMIT)}… [truncated 42 chars]`,
    },
    {name: 'bash', args: {command: 'cat small'}, result: short},
  ]);
});

test('the grader does not import the metrics module', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/evals/task/grade.ts'),
    'utf8',
  );

  assert.equal(source.includes('metrics.js'), false);
});
