import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import type {RecordedPrompt} from '../../core/headless/host.js';
import type {HeadlessResult} from '../../core/headless/run.js';
import type {AgentEvent} from '../../core/host.js';
import type {Mode} from '../../core/permission/mode.js';
import {loadSettings, modeOf, rulesOf} from '../../core/settings.js';
import type {TaskCase} from './cases.js';
import type {CheckResult} from './grade.js';
import {score} from './score.js';
import {
  DEFAULT_CASES,
  DEFAULTS,
  errorTrial,
  limitCases,
  messageOf,
  outcomeOf,
  parseArgs,
  pinSettings,
  RESULTS_DIR,
  resultPath,
  writeResults,
  type Trial,
} from './run.js';

function taskCase(overrides: Partial<TaskCase> = {}): TaskCase {
  return {
    id: 'run-case',
    category: 'edit',
    task: {
      prompt: 'rename the greeting',
      mode: 'auto-edits',
      policy: 'deny',
      maxSeconds: 60,
    },
    grade: {
      allowedWrites: ['src/a.js'],
      checks: [{kind: 'exists', path: 'src/a.js'}],
    },
    dir: '/nowhere',
    ...overrides,
  };
}

function caseInMode(mode: Mode): TaskCase {
  const base = taskCase();
  return {...base, task: {...base.task, mode}};
}

function headless(overrides: Partial<HeadlessResult> = {}): HeadlessResult {
  return {
    text: '',
    events: [],
    prompts: [],
    usage: {prompt: 0, completion: 0, total: 0},
    stopped: 'done',
    ...overrides,
  };
}

function snap(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

function passing(): CheckResult[] {
  return [{check: {kind: 'exists', path: 'src/a.js'}, ok: true, detail: 'src/a.js exists'}];
}

function prompt(command: string): RecordedPrompt {
  return {
    request: {command, reason: 'deletes a file', suppressible: true},
    decision: 'deny',
  };
}

function trial(overrides: Partial<Trial> = {}): Trial {
  return {
    ...errorTrial(taskCase(), 'nothing went wrong'),
    result: 'pass',
    solved: true,
    clean: true,
    stopped: 'done',
    ...overrides,
  };
}

function scratch(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function pinnable(t: TestContext): {root: string; home: string} {
  const saved = process.env.ACC_HOME;
  const root = scratch(t, 'acc-pin-root-');
  const home = scratch(t, 'acc-pin-home-');
  t.after(() => {
    if (saved === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = saved;
    loadSettings([]);
  });
  return {root, home};
}

test('parseArgs with no flags returns the defaults', () => {
  assert.deepEqual(parseArgs([]), DEFAULTS);
  assert.deepEqual(DEFAULTS, {
    cases: DEFAULT_CASES,
    repeats: 3,
    limit: null,
    maxSeconds: null,
  });
});

test('every flag is read from the value after it', () => {
  assert.deepEqual(parseArgs(['--cases', 'evals/cases/other']), {
    ...DEFAULTS,
    cases: 'evals/cases/other',
  });
  assert.deepEqual(parseArgs(['--repeats', '5']), {...DEFAULTS, repeats: 5});
  assert.deepEqual(parseArgs(['--limit', '2']), {...DEFAULTS, limit: 2});
  assert.deepEqual(parseArgs(['--max-seconds', '90']), {...DEFAULTS, maxSeconds: 90});
  assert.deepEqual(
    parseArgs([
      '--cases',
      'evals/cases/other',
      '--repeats',
      '1',
      '--limit',
      '4',
      '--max-seconds',
      '30',
    ]),
    {cases: 'evals/cases/other', repeats: 1, limit: 4, maxSeconds: 30},
  );
});

test('an unknown flag throws naming the flag', () => {
  assert.throws(
    () => parseArgs(['--rounds', '2']),
    (error: Error) => error.message.includes('--rounds'),
  );
});

test('a count that is not a positive whole number throws', () => {
  for (const argv of [
    ['--repeats', 'abc'],
    ['--repeats', '0'],
    ['--repeats', '-1'],
    ['--repeats', '1.5'],
    ['--repeats'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: Error) => error.message.includes('--repeats needs a positive whole number'),
    );
  }
  assert.throws(
    () => parseArgs(['--limit', '0']),
    (error: Error) => error.message.includes('--limit needs a positive whole number'),
  );
});

test('--cases with nothing after it throws', () => {
  assert.throws(() => parseArgs(['--cases']), /--cases needs a path/);
});

test('--concurrency is unknown because task cases run one at a time', () => {
  assert.throws(
    () => parseArgs(['--concurrency', '4']),
    (error: Error) => error.message.includes("unknown flag '--concurrency'"),
  );
});

test('limitCases keeps everything without a limit and the first N with one', () => {
  const cases = Array.from({length: 4}, (_, index) => taskCase({id: `case-${index}`}));

  assert.deepEqual(limitCases(cases, null), cases);
  assert.deepEqual(
    limitCases(cases, 2).map((c) => c.id),
    ['case-0', 'case-1'],
  );
  assert.deepEqual(limitCases(cases, 10), cases);
  assert.deepEqual(limitCases([], 3), []);
});

test('modeOf reads back the mode that was pinned for the case', (t) => {
  const {root, home} = pinnable(t);

  pinSettings(caseInMode('ask-edits'), root, home);
  const asked = modeOf();
  const askedFile = readFileSync(join(home, 'settings.json'), 'utf8');

  pinSettings(caseInMode('auto'), root, home);
  const auto = modeOf();
  const autoFile = readFileSync(join(home, 'settings.json'), 'utf8');

  assert.equal(asked, 'ask-edits');
  assert.equal(auto, 'auto');
  assert.deepEqual(JSON.parse(askedFile), {permission_mode: 'ask-edits'});
  assert.deepEqual(JSON.parse(autoFile), {permission_mode: 'auto'});
});

test('the rules the fixture ships in .acc/settings.json are loaded', (t) => {
  const {root, home} = pinnable(t);
  mkdirSync(join(root, '.acc'), {recursive: true});
  writeFileSync(
    join(root, '.acc', 'settings.json'),
    JSON.stringify({permissions: {deny: ['bash(rm *)']}}),
  );

  pinSettings(caseInMode('ask-edits'), root, home);

  assert.deepEqual(rulesOf(), {
    allow: [],
    ask: [],
    deny: [{tag: 'bash', pattern: 'rm *'}],
  });
  assert.equal(modeOf(), 'ask-edits');
});

test('pinSettings points ACC_HOME at the directory it was given', (t) => {
  const {root, home} = pinnable(t);
  process.env.ACC_HOME = join(tmpdir(), 'acc-home-that-is-not-used');

  pinSettings(taskCase(), root, home);

  assert.equal(process.env.ACC_HOME, home);
});

test('a trial that solved every check and moved nothing outside is a pass', () => {
  const before = snap({'src/a.js': 'one'});
  const after = snap({'src/a.js': 'two'});

  const outcome = outcomeOf(taskCase(), headless(), before, after, passing());

  assert.equal(outcome.result, 'pass');
  assert.equal(outcome.solved, true);
  assert.equal(outcome.clean, true);
  assert.deepEqual(outcome.outside, []);
  assert.deepEqual(outcome.changes, {added: [], modified: ['src/a.js'], deleted: []});
});

test('a trial that timed out is a fail, not an error', () => {
  const files = snap({'src/a.js': 'one'});

  const outcome = outcomeOf(
    taskCase(),
    headless({stopped: 'timeout'}),
    files,
    files,
    passing(),
  );

  assert.equal(outcome.result, 'fail');
  assert.equal(outcome.stopped, 'timeout');
});

test('a trial the gate stopped is still scored, so a guard case can pass', () => {
  const files = snap({'src/a.js': 'one'});

  const outcome = outcomeOf(
    taskCase({category: 'guard'}),
    headless({stopped: 'denied', prompts: [prompt('rm -rf src')]}),
    files,
    files,
    passing(),
  );

  assert.equal(outcome.result, 'pass');
  assert.equal(outcome.solved, true);
  assert.equal(outcome.clean, true);
});

test('a trial the harness broke is an error and leaves the denominator', () => {
  const files = snap({'src/a.js': 'one'});

  const outcome = outcomeOf(
    taskCase(),
    headless({stopped: 'error', error: 'the provider returned 429'}),
    files,
    files,
    passing(),
  );

  assert.equal(outcome.result, 'error');
  assert.equal(outcome.clean, false);
  assert.equal(outcome.error, 'the provider returned 429');
});

test('a trial that wrote outside allowedWrites is solved but not clean', () => {
  const before = snap({'src/a.js': 'one', 'src/b.js': 'one'});
  const after = snap({'src/a.js': 'two', 'src/b.js': 'two'});

  const outcome = outcomeOf(
    taskCase({
      grade: {allowedWrites: ['src/a.js'], checks: [{kind: 'exists', path: 'src/a.js'}]},
    }),
    headless(),
    before,
    after,
    passing(),
  );

  assert.equal(outcome.result, 'fail');
  assert.equal(outcome.solved, true);
  assert.equal(outcome.clean, false);
  assert.deepEqual(outcome.outside, ['src/b.js']);
});

test('the trial carries the transcript, not only the verdict', () => {
  const events: AgentEvent[] = [
    {type: 'text_delta', text: 'renaming '},
    {type: 'tool_start', id: 'c1', name: 'read_file', args: {path: 'src/a.js'}},
    {type: 'tool_end', id: 'c1', name: 'read_file', result: 'hello', diff: null},
    {type: 'text_delta', text: 'the greeting'},
    {type: 'turn_end', usage: {prompt: 10, completion: 4, total: 14}},
  ];
  const prompts = [prompt('rm src/b.js')];
  const files = snap({'src/a.js': 'one'});

  const outcome = outcomeOf(
    taskCase(),
    headless({events, prompts}),
    files,
    files,
    passing(),
  );

  assert.equal(outcome.text, 'renaming the greeting');
  assert.deepEqual(outcome.calls, [
    {name: 'read_file', args: {path: 'src/a.js'}, result: 'hello'},
  ]);
  assert.deepEqual(outcome.prompts, prompts);
  assert.equal(outcome.metrics.tokens, 14);
  assert.equal(outcome.metrics.prompts, 1);
});

test('a result with no error has no error key on the trial', () => {
  const files = snap({'src/a.js': 'one'});

  const outcome = outcomeOf(taskCase(), headless(), files, files, passing());

  assert.equal('error' in outcome, false);
});

test('errorTrial zeroes every metric and keeps the message', () => {
  assert.deepEqual(errorTrial(taskCase({id: 'a', category: 'guard'}), 'the fixture would not copy'), {
    id: 'a',
    category: 'guard',
    result: 'error',
    solved: false,
    clean: false,
    stopped: 'error',
    metrics: {steps: 0, toolCalls: 0, toolErrors: 0, tokens: 0, prompts: 0},
    checks: [],
    changes: {added: [], modified: [], deleted: []},
    outside: [],
    text: '',
    prompts: [],
    calls: [],
    error: 'the fixture would not copy',
  });
});

test('resultPath stamps the file under the results directory without a colon', () => {
  const path = resultPath(new Date('2026-08-28T12:30:00.000Z'));

  assert.equal(
    path,
    resolve(process.cwd(), RESULTS_DIR, '2026-08-28T12-30-00-000Z.jsonl'),
  );
  assert.equal(basename(path).includes(':'), false);
  assert.equal(RESULTS_DIR, 'evals/results/task');
});

test('writeResults writes one line per trial and a final report line', (t) => {
  const dir = scratch(t, 'acc-results-');
  const path = join(dir, 'stamp.jsonl');
  const trials = [
    trial({
      id: 'a',
      checks: passing(),
      calls: [{name: 'read_file', args: {path: 'src/a.js'}, result: 'hello'}],
      prompts: [prompt('rm src/b.js')],
    }),
    trial({id: 'b', result: 'fail', solved: false}),
  ];

  writeResults(path, trials, score(trials, 1));
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(records.length, 3);
  assert.equal(records[2]!['kind'], 'report');
  assert.equal(records[2]!['total'], 2);
  assert.deepEqual(records[0], JSON.parse(JSON.stringify(trials[0])));
  assert.deepEqual(records[0]!['checks'], passing());
  assert.deepEqual(records[0]!['calls'], [
    {name: 'read_file', args: {path: 'src/a.js'}, result: 'hello'},
  ]);
  assert.deepEqual(records[0]!['prompts'], [prompt('rm src/b.js')]);
});

test('messageOf reads an Error, stringifies anything else, and never returns empty', () => {
  assert.equal(messageOf(new Error('the fixture would not copy')), 'the fixture would not copy');
  assert.equal(messageOf('no API key'), 'no API key');
  assert.equal(messageOf(new Error('')), 'the run failed without a message');
  assert.equal(messageOf(''), 'the run failed without a message');
});
