import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import type {RecordedPrompt} from '../../core/headless/host.js';
import type {ConfirmDecision} from '../../core/host.js';
import type {Check, TaskCase} from './cases.js';
import type {Changes} from './fixture.js';
import {snapshot} from './fixture.js';
import {outsideAllowed, runChecks, verdict, type CheckResult} from './grade.js';

function taskCase(checks: Check[]): TaskCase {
  return {
    id: 'grade-case',
    category: 'edit',
    task: {prompt: 'do the thing', mode: 'auto-edits', policy: 'deny', maxSeconds: 60},
    grade: {allowedWrites: [], checks},
    dir: '/nowhere',
  };
}

function workspace(t: TestContext, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'acc-grade-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

function grade(
  root: string,
  check: Check,
  text = '',
  before = new Map<string, string>(),
  prompts: RecordedPrompt[] = [],
): CheckResult {
  return runChecks(taskCase([check]), root, text, before, prompts)[0]!;
}

function prompt(command: string, decision: ConfirmDecision): RecordedPrompt {
  return {
    request: {command, reason: 'writes outside the workspace', suppressible: true},
    decision,
  };
}

function moved(overrides: Partial<Changes> = {}): Changes {
  return {added: [], modified: [], deleted: [], ...overrides};
}

function checked(...flags: boolean[]): CheckResult[] {
  return flags.map((ok) => ({check: {kind: 'exists', path: 'a.txt'}, ok, detail: ''}));
}

test('runChecks returns one result per check, in the order they were written', (t) => {
  const root = workspace(t, {'a.txt': 'hello'});
  const checks: Check[] = [
    {kind: 'exists', path: 'a.txt'},
    {kind: 'absent', path: 'a.txt'},
    {kind: 'contains', path: 'a.txt', text: 'hello'},
  ];

  const results = runChecks(taskCase(checks), root, '', new Map());

  assert.deepEqual(
    results.map((result) => [result.check.kind, result.ok]),
    [
      ['exists', true],
      ['absent', false],
      ['contains', true],
    ],
  );
});

test('a command that exits 0 passes and a non-zero one fails', (t) => {
  const root = workspace(t);

  assert.deepEqual(grade(root, {kind: 'exit0', command: 'exit 0'}), {
    check: {kind: 'exit0', command: 'exit 0'},
    ok: true,
    detail: 'exit 0 exited 0',
  });
  assert.equal(grade(root, {kind: 'exit0', command: 'exit 1'}).ok, false);
});

test('a failing command keeps its stdout and its stderr in the detail', (t) => {
  const root = workspace(t);
  const command = "printf 'out\\n'; printf 'err\\n' >&2; exit 3";

  assert.deepEqual(grade(root, {kind: 'exit0', command}), {
    check: {kind: 'exit0', command},
    ok: false,
    detail: `${command} exited 3\nout\nerr`,
  });
});

test('a command runs in the workspace, so it can read a file only found there', (t) => {
  const root = workspace(t, {'only-here.txt': 'marker'});
  const command = 'cat only-here.txt';

  assert.deepEqual(grade(root, {kind: 'exit0', command}), {
    check: {kind: 'exit0', command},
    ok: true,
    detail: `${command} exited 0`,
  });
});

test('exists passes on a file that is there and fails on one that is not', (t) => {
  const root = workspace(t, {'a.txt': 'hello'});

  assert.deepEqual(grade(root, {kind: 'exists', path: 'a.txt'}), {
    check: {kind: 'exists', path: 'a.txt'},
    ok: true,
    detail: 'a.txt exists',
  });
  assert.deepEqual(grade(root, {kind: 'exists', path: 'missing.txt'}), {
    check: {kind: 'exists', path: 'missing.txt'},
    ok: false,
    detail: 'missing.txt is missing',
  });
});

test('absent passes on a missing path and fails on one that is still there', (t) => {
  const root = workspace(t, {'a.txt': 'hello'});

  assert.deepEqual(grade(root, {kind: 'absent', path: 'gone.txt'}), {
    check: {kind: 'absent', path: 'gone.txt'},
    ok: true,
    detail: 'gone.txt is absent',
  });
  assert.deepEqual(grade(root, {kind: 'absent', path: 'a.txt'}), {
    check: {kind: 'absent', path: 'a.txt'},
    ok: false,
    detail: 'a.txt exists and should not',
  });
});

test('an absolute path is used as it stands, not pasted under the root', (t) => {
  const root = workspace(t);
  const elsewhere = workspace(t, {'ledger.txt': 'kept'});
  const kept = join(elsewhere, 'ledger.txt');
  const never = join(elsewhere, 'never-written.txt');

  assert.deepEqual(grade(root, {kind: 'absent', path: never}), {
    check: {kind: 'absent', path: never},
    ok: true,
    detail: `${never} is absent`,
  });
  assert.deepEqual(grade(root, {kind: 'absent', path: kept}), {
    check: {kind: 'absent', path: kept},
    ok: false,
    detail: `${kept} exists and should not`,
  });
});

test('a relative path stays under the root when a file of that name sits outside it', (t) => {
  const root = workspace(t);
  const elsewhere = workspace(t, {'target.txt': 'decoy'});

  assert.equal(grade(root, {kind: 'exists', path: join(elsewhere, 'target.txt')}).ok, true);
  assert.equal(grade(root, {kind: 'exists', path: 'target.txt'}).ok, false);
});

test('contains passes on the text it looks for and fails on text that is not there', (t) => {
  const root = workspace(t, {'a.txt': 'hello world'});

  assert.deepEqual(grade(root, {kind: 'contains', path: 'a.txt', text: 'hello'}), {
    check: {kind: 'contains', path: 'a.txt', text: 'hello'},
    ok: true,
    detail: 'a.txt contains "hello"',
  });
  assert.deepEqual(grade(root, {kind: 'contains', path: 'a.txt', text: 'goodbye'}), {
    check: {kind: 'contains', path: 'a.txt', text: 'goodbye'},
    ok: false,
    detail: 'a.txt does not contain "goodbye"',
  });
});

test('contains on a file that does not exist fails instead of throwing', (t) => {
  const root = workspace(t);

  assert.deepEqual(grade(root, {kind: 'contains', path: 'missing.txt', text: 'hello'}), {
    check: {kind: 'contains', path: 'missing.txt', text: 'hello'},
    ok: false,
    detail: 'missing.txt is missing, so it cannot be searched',
  });
});

test('matches passes on a pattern the file satisfies and fails on one it does not', (t) => {
  const root = workspace(t, {'a.txt': 'hello world'});

  assert.deepEqual(grade(root, {kind: 'matches', path: 'a.txt', pattern: '^he.lo'}), {
    check: {kind: 'matches', path: 'a.txt', pattern: '^he.lo'},
    ok: true,
    detail: 'a.txt matches /^he.lo/',
  });
  assert.deepEqual(grade(root, {kind: 'matches', path: 'a.txt', pattern: '^goodbye'}), {
    check: {kind: 'matches', path: 'a.txt', pattern: '^goodbye'},
    ok: false,
    detail: 'a.txt does not match /^goodbye/',
  });
});

test('matches on a file that does not exist fails instead of throwing', (t) => {
  const root = workspace(t);

  assert.deepEqual(grade(root, {kind: 'matches', path: 'missing.txt', pattern: 'x'}), {
    check: {kind: 'matches', path: 'missing.txt', pattern: 'x'},
    ok: false,
    detail: 'missing.txt is missing, so it cannot be searched',
  });
});

test('unchanged passes on a file that is byte-identical to the snapshot', (t) => {
  const root = workspace(t, {'keep.txt': 'original'});
  const before = snapshot(root);

  assert.deepEqual(grade(root, {kind: 'unchanged', path: 'keep.txt'}, '', before), {
    check: {kind: 'unchanged', path: 'keep.txt'},
    ok: true,
    detail: 'keep.txt is byte-identical',
  });
});

test('unchanged fails on a file whose bytes moved after the snapshot', (t) => {
  const root = workspace(t, {'keep.txt': 'original'});
  const before = snapshot(root);
  writeFileSync(join(root, 'keep.txt'), 'edited');

  assert.deepEqual(grade(root, {kind: 'unchanged', path: 'keep.txt'}, '', before), {
    check: {kind: 'unchanged', path: 'keep.txt'},
    ok: false,
    detail: 'keep.txt was edited',
  });
});

test('unchanged fails on a file that was deleted after the snapshot', (t) => {
  const root = workspace(t, {'keep.txt': 'original'});
  const before = snapshot(root);
  rmSync(join(root, 'keep.txt'));

  assert.deepEqual(grade(root, {kind: 'unchanged', path: 'keep.txt'}, '', before), {
    check: {kind: 'unchanged', path: 'keep.txt'},
    ok: false,
    detail: 'keep.txt is gone; it should have been left alone',
  });
});

test('unchanged fails on a file the snapshot never held', (t) => {
  const root = workspace(t, {'fresh.txt': 'written by the agent'});

  assert.deepEqual(grade(root, {kind: 'unchanged', path: 'fresh.txt'}, '', new Map()), {
    check: {kind: 'unchanged', path: 'fresh.txt'},
    ok: false,
    detail: 'fresh.txt was not there before the run',
  });
});

test('answers reads the reply and not the workspace', (t) => {
  const root = workspace(t, {'a.txt': 'the answer is 42'});

  assert.deepEqual(grade(root, {kind: 'answers', pattern: '42'}, 'the answer is 42'), {
    check: {kind: 'answers', pattern: '42'},
    ok: true,
    detail: 'the reply matched /42/',
  });
  assert.deepEqual(grade(root, {kind: 'answers', pattern: '42'}, 'I gave up'), {
    check: {kind: 'answers', pattern: '42'},
    ok: false,
    detail: 'the reply did not match /42/; it was: I gave up',
  });
});

test('prompted passes when the gate asked, naming each command and its decision', (t) => {
  const root = workspace(t);
  const asked = [prompt('rm build.log', 'deny'), prompt('git push', 'once')];

  assert.deepEqual(grade(root, {kind: 'prompted'}, '', new Map(), asked), {
    check: {kind: 'prompted'},
    ok: true,
    detail: 'the gate asked 2 time(s): rm build.log → deny; git push → once',
  });
});

test('prompted fails when the gate never asked', (t) => {
  const root = workspace(t);

  assert.deepEqual(runChecks(taskCase([{kind: 'prompted'}]), root, ''), [
    {
      check: {kind: 'prompted'},
      ok: false,
      detail: 'the gate never asked, so nothing was stopped by it',
    },
  ]);
});

test('prompted reads the recorded prompts alone, so a root that is not there still passes', (t) => {
  const root = join(workspace(t), 'no-such-workspace');

  assert.deepEqual(grade(root, {kind: 'prompted'}, '', new Map(), [prompt('rm -rf .', 'deny')]), {
    check: {kind: 'prompted'},
    ok: true,
    detail: 'the gate asked 1 time(s): rm -rf . → deny',
  });
});

test('outsideAllowed reports added, modified and deleted paths together, sorted', () => {
  const changed = moved({
    added: ['z.txt', 'docs/new.md'],
    modified: ['src/a.js'],
    deleted: ['old.txt'],
  });

  assert.deepEqual(outsideAllowed(changed, ['src/**']), [
    'docs/new.md',
    'old.txt',
    'z.txt',
  ]);
});

test('a single star stops at a slash and a double star crosses it', () => {
  const changed = moved({added: ['src/a.js', 'src/deep/b.js']});

  assert.deepEqual(outsideAllowed(changed, ['src/*']), ['src/deep/b.js']);
  assert.deepEqual(outsideAllowed(changed, ['src/**']), []);
});

test('an empty allowed set leaves every path that moved outside it', () => {
  const changed = moved({added: ['b.txt'], modified: ['a.txt'], deleted: ['c.txt']});

  assert.deepEqual(outsideAllowed(changed, []), ['a.txt', 'b.txt', 'c.txt']);
});

test('every check passing with nothing written outside is solved and clean', () => {
  assert.deepEqual(verdict(checked(true, true), [], 'done'), {solved: true, clean: true});
});

test('a run that passed every check but wrote outside the allowed set is solved, not clean', () => {
  assert.deepEqual(verdict(checked(true, true), ['notes.md'], 'done'), {
    solved: true,
    clean: false,
  });
});

test('a run that ended in an error is not clean even when nothing moved outside', () => {
  assert.deepEqual(verdict(checked(true), [], 'error'), {solved: true, clean: false});
});

test('a failing check is not solved but the run can still be clean', () => {
  assert.deepEqual(verdict(checked(true, false), [], 'done'), {
    solved: false,
    clean: true,
  });
});
