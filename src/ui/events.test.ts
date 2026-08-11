import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffSummary,
  failureOutput,
  formatArgs,
  formatResult,
  noticeText,
  resultCount,
  resultStatus,
  statusFor,
  toolDescription,
  writeSummary,
  type Item,
} from './events.js';

test('resultStatus keeps the failure reason on the line', () => {
  assert.equal(
    resultStatus('read_file', 'Error: no such file: src/main.ts'),
    'failed: no such file: src/main.ts',
  );
  assert.equal(
    resultStatus('edit_file', 'Error: old_string not found\nsecond line'),
    'failed: old_string not found',
  );
  assert.equal(resultStatus('read_file', 'Error:'), 'failed');
});

test('resultStatus truncates a long failure reason', () => {
  assert.equal(
    resultStatus('bash', `Error: ${'x'.repeat(80)}`),
    `failed: ${'x'.repeat(50)}…`,
  );
});

test('resultStatus summarizes tool outcomes', () => {
  assert.equal(resultStatus('bash', '[exit 0]\npassed\n'), 'exit 0');
  assert.equal(resultStatus('bash', '[exit 2]\nfailed\n'), 'exit 2');
  assert.equal(resultStatus('read_file', 'x = 1'), 'done');
});

test('formatArgs hides a redundant bash workspace change', () => {
  assert.equal(
    formatArgs(
      'bash',
      {
        command:
          'cd /Users/dev/Desktop/test-demo && python3 test_pocket_tasks.py',
      },
      '/Users/dev/Desktop/test-demo',
    ),
    'python3 test_pocket_tasks.py',
  );
});

test('toolDescription reads the goal a bash call states', () => {
  assert.equal(
    toolDescription('bash', {
      command: 'git ls-files',
      description: 'List the tracked files',
    }),
    'List the tracked files',
  );
  assert.equal(toolDescription('bash', {command: 'git ls-files'}), '');
  assert.equal(
    toolDescription('read_file', {description: 'Read the entry point'}),
    '',
  );
});

test('formatArgs shortens other absolute paths in bash summaries', () => {
  assert.equal(
    formatArgs('bash', {
      command: 'cd /Users/dev/Desktop/other && python3 check.py',
    }),
    'cd …/other && python3 check.py',
  );
});

test('formatArgs keeps up to 80 characters in command summaries', () => {
  const eightyCharacters = 'x'.repeat(80);

  assert.equal(
    formatArgs('bash', {command: eightyCharacters}),
    eightyCharacters,
  );
  assert.equal(
    formatArgs('bash', {command: `${eightyCharacters}x`}),
    `${eightyCharacters}…`,
  );
});

test('formatArgs makes file-tool paths relative to the workspace', () => {
  const workspace = '/Users/dev/Desktop/test-demo2';

  assert.equal(formatArgs('read_file', {path: workspace}, workspace), '.');
  assert.equal(
    formatArgs('read_file', {path: `${workspace}/src/app.py`}, workspace),
    'src/app.py',
  );
  assert.equal(
    formatArgs('write_file', {path: 'README.md'}, workspace),
    'README.md',
  );
});

test('formatResult keeps useful shell status', () => {
  assert.equal(formatResult('bash', '[exit 0]\npassed\n'), 'passed');
  assert.equal(formatResult('bash', '[exit 2]\nfailed\n'), 'exit 2\nfailed');
});

test('failureOutput keeps the tail of a failed command', () => {
  const body = Array.from({length: 14}, (_, i) => `line ${i + 1}`).join('\n');
  const output = failureOutput('bash', `[exit 1]\n${body}\n`);

  assert.equal(output?.split('\n').length, 10);
  assert.match(String(output), /line 14$/);
  assert.doesNotMatch(String(output), /line 4\b/);
});

test('failureOutput stays quiet on success and on other tools', () => {
  assert.equal(failureOutput('bash', '[exit 0]\nall good\n'), null);
  assert.equal(failureOutput('bash', '[exit 1]\n'), null);
  assert.equal(failureOutput('read_file', 'some text'), null);
});

test('resultCount admits when the tool output was cut off', () => {
  const result = 'a\nb\n... [truncated]';

  assert.equal(resultCount('read_file', result), '3 lines (truncated)');
});

test('resultCount shows the returned range and total file size', () => {
  assert.equal(
    resultCount('read_file', 'x = 1\n[file has 214 lines; showing 1-40.]'),
    'lines 1–40 of 214',
  );
  assert.equal(
    resultCount('read_file', 'x = 1\n[file has 1234 lines; showing 401-800.]'),
    'lines 401–800 of 1,234',
  );
});

test('resultCount counts a whole small file that came back untruncated', () => {
  assert.equal(resultCount('read_file', 'a\nb\nc\n'), '3 lines');
});

test('resultCount has nothing to say about tools it does not cover', () => {
  assert.equal(resultCount('bash', '[exit 0]\nhi'), null);
  assert.equal(resultCount('write_file', "Wrote 10 chars to 'a.ts'."), null);
});

test('writeSummary reports the size of a newly created file', () => {
  assert.equal(
    writeSummary('write_file', "Wrote 4211 chars to 'parser.py'."),
    'created, 4,211 chars',
  );
});

test('writeSummary ignores tools that are not write_file', () => {
  assert.equal(writeSummary('read_file', 'Wrote 10 chars'), null);
  assert.equal(writeSummary('write_file', 'Error: denied'), null);
});

test('noticeText surfaces the hint buried in a tool result', () => {
  assert.equal(
    noticeText(
      "Wrote 40 chars to 'runtme.py'. Note: a similar file already exists" +
        ' (runtime.py). If you meant that file, this created a new one instead.',
    ),
    'a similar file already exists (runtime.py). If you meant that file,' +
      ' this created a new one instead.',
  );
});

test('noticeText stays silent when a result had nothing to warn about', () => {
  assert.equal(noticeText("Wrote 40 chars to 'runtime.py'."), null);
});

test('diffSummary counts the full change, not the visible rows', () => {
  assert.equal(
    diffSummary({path: 'a.py', rows: [], hidden: 20, added: 12, removed: 3}),
    '+12 −3',
  );
  assert.equal(
    diffSummary({path: 'a.py', rows: [], hidden: 0, added: 4, removed: 0}),
    '+4',
  );
});

test('statusFor names the tool that is running', () => {
  const items: Item[] = [
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'c1', name: 'bash', args: {command: 'ls'}},
    },
  ];

  assert.equal(statusFor('', items), 'Running bash…');
  assert.equal(statusFor('partial answer', items), 'Responding…');
  assert.equal(statusFor('', []), 'Thinking…');
});
