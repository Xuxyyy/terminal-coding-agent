import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exitCode,
  jsonLines,
  plainLines,
} from '../../../core/headless/output.js';
import type {HeadlessResult} from '../../../core/headless/run.js';

function headlessResult(
  overrides: Partial<HeadlessResult> = {},
): HeadlessResult {
  return {
    text: '',
    events: [],
    prompts: [],
    usage: {prompt: 0, completion: 0, total: 0},
    stopped: 'done',
    ...overrides,
  };
}

const writeCall: HeadlessResult['events'] = [
  {type: 'tool_start', id: 'c1', name: 'write_file', args: {path: 'note.txt'}},
  {
    type: 'tool_end',
    id: 'c1',
    name: 'write_file',
    result: "Wrote 4 chars to 'note.txt'.",
    diff: null,
  },
  {type: 'text_delta', text: 'wrote '},
  {type: 'text_delta', text: 'it'},
  {type: 'turn_end', usage: {prompt: 40, completion: 7, total: 47}},
];

test('the answer alone goes to out and the tool line goes to err', () => {
  const {out, err} = plainLines(
    headlessResult({text: 'wrote it', events: writeCall}),
  );

  assert.equal(out, 'wrote it');
  assert.deepEqual(err, ['tool: write_file']);
});

test('a refused command is written to err with its decision', () => {
  const {err} = plainLines(
    headlessResult({
      stopped: 'denied',
      prompts: [
        {
          request: {
            command: 'rm -rf note.txt',
            reason: 'deletes a file',
            suppressible: true,
          },
          decision: 'deny',
        },
      ],
    }),
  );

  assert.deepEqual(err, [
    'prompt: rm -rf note.txt -> deny',
    'stopped: denied',
  ]);
});

test('a finished run states no reason, an unfinished one does', () => {
  assert.deepEqual(plainLines(headlessResult({text: 'all done'})).err, []);
  assert.deepEqual(plainLines(headlessResult({stopped: 'timeout'})).err, [
    'stopped: timeout',
  ]);
});

test('the reason line carries the error message when there is one', () => {
  const {err} = plainLines(
    headlessResult({stopped: 'error', error: 'model refused the request'}),
  );

  assert.deepEqual(err, ['stopped: error: model refused the request']);
});

test('json mode prints one line per event and one result line', () => {
  const lines = jsonLines(headlessResult({text: 'wrote it', events: writeCall}));
  const parsed = lines.map((line) => JSON.parse(line) as {kind?: string});

  assert.equal(lines.length, writeCall.length + 1);
  assert.equal(parsed.filter((line) => line.kind === 'result').length, 1);
  assert.equal(parsed.at(-1)?.kind, 'result');
});

test('every json line parses on its own', () => {
  const lines = jsonLines(
    headlessResult({
      text: 'wrote it',
      events: [
        ...writeCall,
        {type: 'error', message: 'stream broke', hint: 'retry'},
      ],
      prompts: [
        {
          request: {command: 'ls', reason: 'lists files', suppressible: true},
          decision: 'once',
        },
      ],
      stopped: 'error',
      error: 'stream broke',
    }),
  );

  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('the result line counts the prompts and the tool steps', () => {
  const lines = jsonLines(
    headlessResult({
      events: [
        ...writeCall,
        {type: 'tool_start', id: 'c2', name: 'bash', args: {command: 'ls'}},
      ],
      prompts: [
        {
          request: {command: 'ls', reason: 'lists files', suppressible: true},
          decision: 'once',
        },
        {
          request: {command: 'rm a', reason: 'deletes', suppressible: true},
          decision: 'deny',
        },
      ],
      usage: {prompt: 40, completion: 7, total: 47},
      stopped: 'denied',
    }),
  );

  assert.deepEqual(JSON.parse(String(lines.at(-1))), {
    kind: 'result',
    stopped: 'denied',
    usage: {prompt: 40, completion: 7, total: 47},
    prompts: 2,
    steps: 2,
  });
});

test('only a finished run exits zero', () => {
  assert.equal(exitCode(headlessResult({stopped: 'done'})), 0);
  assert.equal(exitCode(headlessResult({stopped: 'denied'})), 1);
  assert.equal(exitCode(headlessResult({stopped: 'timeout'})), 1);
  assert.equal(exitCode(headlessResult({stopped: 'error'})), 1);
});
