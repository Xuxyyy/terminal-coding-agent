import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTask,
  contextStatus,
  createSession,
  recordUsage,
} from '../../core/session.js';
import {
  contextReadout,
  diffSummary,
  failureOutput,
  formatArgs,
  formatResult,
  noticeText,
  resultCount,
  resultStatus,
  searchCommand,
  shellQuote,
  splitsCommand,
  statusFor,
  toolDescription,
  writeSummary,
  type Item,
} from '../../ui/events.js';
import {chosenArgv} from '../../core/tools/grep.js';

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

test('resultStatus shortens a long failure reason from the middle', () => {
  assert.equal(
    resultStatus('bash', `Error: ${'x'.repeat(80)}`),
    `failed: ${'x'.repeat(25)}…${'x'.repeat(25)}`,
  );
});

test('resultStatus keeps the reason when a long path fills the line', () => {
  const status = resultStatus(
    'read_file',
    "Error: reads '/private/tmp/claude-501/scratchpad/outside/secret.txt' outside the project",
  );

  assert.match(status, /^failed: reads '\/private/);
  assert.match(status, /outside the project$/);
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

test('resultCount shows the returned range', () => {
  assert.equal(
    resultCount('read_file', 'x = 1\n[file has 214 lines; showing 1-40.]'),
    'lines 1-40',
  );
  assert.equal(
    resultCount('read_file', 'x = 1\n[file has 1234 lines; showing 401-800.]'),
    'lines 401-800',
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

test('an estimated context total is marked with a tilde', () => {
  const session = createSession('/tmp/work', 'rules', 200_000);

  const {line} = contextReadout({kind: 'context', ...contextStatus(session)});

  assert.match(line, /^context: ~[\d,]+ \/ 200,000 tokens \((<1|\d+)%\)$/);
});

test('a measured context total prints without a tilde', () => {
  const session = createSession('/tmp/work', 'rules', 200_000);
  addTask(session, 'do the thing');
  recordUsage(session, {prompt: 12_000, completion: 450, total: 12_450});

  const {line} = contextReadout({kind: 'context', ...contextStatus(session)});

  assert.equal(line, 'context: 12,450 / 200,000 tokens (6%)');
});

test('a stored context item with no breakdown still renders one line', () => {
  const {line, parts} = contextReadout({
    kind: 'context',
    used: 900,
    budget: 200_000,
  });

  assert.deepEqual(
    {line, parts},
    {line: 'context: 900 / 200,000 tokens (<1%)', parts: []},
  );
});

test('a context in use never rounds down to no percent', () => {
  const budget = 262_144;
  const barelyUsed = contextReadout({kind: 'context', used: 1, budget});
  const empty = contextReadout({kind: 'context', used: 0, budget});

  assert.match(barelyUsed.line, /\(<1%\)$/);
  assert.match(empty.line, /\(0%\)$/);
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

test('a grep row carries no headline, only its command', () => {
  const call = {pattern: 'renderWidget', output_mode: 'content'};

  assert.equal(toolDescription('grep', call), '');
  assert.equal(formatArgs('grep', call), 'rg -n renderWidget .');
});

test('the command line drops the flags every search shares', () => {
  const line = searchCommand({pattern: 'widget'});

  assert.equal(line, 'rg -l widget .');
  for (const constant of ['--stats', '--no-require-git', '--hidden', '!.git']) {
    assert.doesNotMatch(line, new RegExp(constant.replace('.', '\\.')), constant);
  }
});

test('a pattern that looks like a flag keeps --regexp in front of it', () => {
  assert.equal(searchCommand({pattern: '-v'}), 'rg -l --regexp -v .');
  assert.equal(searchCommand({pattern: 'v'}), 'rg -l v .');
});

test('a grep command always drops to its own line, a bash one only with a description', () => {
  assert.equal(splitsCommand('grep', ''), true);
  assert.equal(splitsCommand('bash', ''), false);
  assert.equal(splitsCommand('bash', 'Run the project test suite'), true);
  assert.equal(splitsCommand('read_file', ''), false);
});

test('the command under a grep row is built from the flags the tool passes', () => {
  const call = {pattern: 'widget', glob: '*.ts', path: 'src'};

  assert.deepEqual(chosenArgv(call), [
    'rg',
    '-l',
    '--glob',
    '*.ts',
    'widget',
    'src',
  ]);
  assert.equal(searchCommand(call), chosenArgv(call).map(shellQuote).join(' '));
});

test('searchCommand carries the flags the model chose', () => {
  assert.match(searchCommand({pattern: 'w', output_mode: 'count'}), / -c /);
  assert.match(searchCommand({pattern: 'w', case_insensitive: true}), / -i /);
  assert.match(
    searchCommand({pattern: 'w', output_mode: 'content', context: 2}),
    / -n -C 2 /,
  );
  assert.match(searchCommand({pattern: 'w'}), / -l /);
});

test('shellQuote quotes only what a shell would need quoted', () => {
  assert.equal(shellQuote('renderWidget'), 'renderWidget');
  assert.equal(shellQuote('function render'), "'function render'");
  assert.equal(shellQuote('render.*Widget'), "'render.*Widget'");
  assert.equal(shellQuote("it's"), '"it\'s"');
  assert.equal(shellQuote(''), "''");
});

test('a grep command line quotes the pattern and the glob', () => {
  const line = searchCommand({pattern: 'function render', glob: '*.ts'});

  assert.match(line, /'function render'/);
  assert.match(line, /--glob '\*\.ts'/);
});

test('a grep row says nothing when the arguments are unusable', () => {
  assert.equal(searchCommand({}), '');
  assert.equal(searchCommand(null), '');
  assert.equal(formatArgs('grep', {}), '');
  assert.equal(toolDescription('grep', {}), '');
});
