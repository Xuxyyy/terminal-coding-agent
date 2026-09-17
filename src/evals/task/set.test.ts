import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {delimiter, join, resolve} from 'node:path';
import test from 'node:test';
import {isMode} from '../../core/permission/mode.js';
import {loadCases, POLICIES, type Category, type TaskCase} from './cases.js';
import {
  applyOverlay,
  applySolution,
  buildFixture,
  changes,
  removeFixture,
  snapshot,
} from './fixture.js';
import {runChecks} from './grade.js';
import {DEFAULT_CASES} from './run.js';

const cases: TaskCase[] = loadCases(resolve(process.cwd(), DEFAULT_CASES));

process.env['PATH'] = [
  resolve(process.cwd(), 'node_modules', '.bin'),
  process.env['PATH'] ?? '',
].join(delimiter);

const EXPECTED_CATEGORY: Record<string, Category> = {
  'bash-tail-diagnostic': 'recover',
  'diagnose-indirect-failure': 'edit',
  'diagnose-state-leak': 'edit',
  'fix-failing-test': 'edit',
  'follow-project-instructions': 'restraint',
  'no-deleting-the-test': 'restraint',
  'move-module-and-imports': 'edit',
  'preserve-user-wip': 'restraint',
  'rename-across-files': 'edit',
  'recover-incomplete-fix': 'recover',
  'recover-wrong-command': 'recover',
  'repair-build-config': 'recover',
  'repair-type-contract': 'edit',
  'create-to-spec': 'create',
  'answer-needs-grep': 'find',
  'already-done': 'restraint',
  'ask-edits-stops-a-write': 'guard',
  'outside-the-root': 'guard',
  'read-truncation-repair': 'recover',
  'grep-narrow': 'recover',
  'verify-after-fix': 'edit',
  'write-regression-test': 'edit',
};

const FOCUSED = [
  'bash-tail-diagnostic',
  'diagnose-indirect-failure',
  'diagnose-state-leak',
  'follow-project-instructions',
  'move-module-and-imports',
  'preserve-user-wip',
  'recover-incomplete-fix',
  'recover-wrong-command',
  'repair-build-config',
  'repair-type-contract',
  'verify-after-fix',
  'write-regression-test',
];

const READ_ONLY = [
  'already-done',
  'answer-needs-grep',
  'ask-edits-stops-a-write',
  'grep-narrow',
  'outside-the-root',
  'read-truncation-repair',
];

const WRITING = [
  'create-to-spec',
  'fix-failing-test',
  'no-deleting-the-test',
  'rename-across-files',
];

function idsWhere(predicate: (c: TaskCase) => boolean): string[] {
  return cases.filter(predicate).map((c) => c.id);
}

function answerPatterns(c: TaskCase): string[] {
  return c.grade.checks.flatMap((check) =>
    check.kind === 'answers' ? [check.pattern] : [],
  );
}

function solved(c: TaskCase): string[] {
  const root = buildFixture(c);
  try {
    const before = snapshot(root);
    applySolution(c, root);
    return runChecks(c, root, c.grade.expectedAnswer ?? '', before)
      .filter(
        (result) =>
          result.check.kind !== 'tool' && result.check.kind !== 'prompted',
      )
      .filter((result) => !result.ok)
      .map((result) => `${c.id}: ${result.detail}`);
  } finally {
    removeFixture(root);
  }
}

function startsUnsolved(c: TaskCase): boolean {
  const root = buildFixture(c);
  try {
    const before = snapshot(root);
    return runChecks(c, root, c.grade.expectedAnswer ?? '', before)
      .filter(
        (result) =>
          result.check.kind !== 'tool' && result.check.kind !== 'prompted',
      )
      .some((result) => !result.ok);
  } finally {
    removeFixture(root);
  }
}

function rejectsCounterexample(c: TaskCase): string | null {
  const root = buildFixture(c);
  try {
    const before = snapshot(root);
    const applied = applyOverlay(c, root, 'counterexample');
    if (!applied && c.grade.counterexampleAnswer === undefined) {
      return `${c.id}: has no counterexample overlay or answer`;
    }
    const results = runChecks(
      c,
      root,
      c.grade.counterexampleAnswer ?? c.grade.expectedAnswer ?? '',
      before,
    ).filter(
      (result) => result.check.kind !== 'tool' && result.check.kind !== 'prompted',
    );
    return results.some((result) => !result.ok)
      ? null
      : `${c.id}: counterexample passes every non-procedural check`;
  } finally {
    removeFixture(root);
  }
}

function touched(c: TaskCase): string[] {
  const root = buildFixture(c);
  try {
    const before = snapshot(root);
    applySolution(c, root);
    const moved = changes(before, snapshot(root));
    return [...moved.added, ...moved.modified, ...moved.deleted].sort();
  } finally {
    removeFixture(root);
  }
}

test('the whole set loads ten smoke and twelve focused cases', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['smoke', 'focused', 'workflow'].map((suite) => [
        suite,
        cases.filter((c) => c.suite === suite).length,
      ]),
    ),
    {smoke: 10, focused: 12, workflow: 0},
  );
});

test('the ids and categories are the ones the plan named', () => {
  assert.deepEqual(
    Object.fromEntries(cases.map((c) => [c.id, c.category])),
    EXPECTED_CATEGORY,
  );
});

test('the ten preserved cases are all in the smoke suite', () => {
  const smoke = cases.filter((c) => c.suite === 'smoke');
  assert.deepEqual(
    smoke.map((c) => [c.id, c.suite]),
    smoke.map((c) => [c.id, 'smoke']),
  );
});

test('the focused suite contains exactly the twelve planned cases', () => {
  assert.deepEqual(idsWhere((c) => c.suite === 'focused'), FOCUSED);
});

test('every reference solution satisfies its non-procedural checks', () => {
  assert.deepEqual(cases.flatMap(solved), []);
});

test('every focused starting fixture fails a non-procedural check', () => {
  assert.deepEqual(idsWhere((c) => c.suite === 'focused' && !startsUnsolved(c)), []);
});

test('every focused case has both overlays and rejects its counterexample', () => {
  const focused = cases.filter((c) => c.suite === 'focused');
  assert.deepEqual(
    focused.flatMap((c) =>
      ['solution', 'counterexample']
        .filter((overlay) => !existsSync(join(c.dir, overlay)))
        .map((overlay) => `${c.id}: missing ${overlay}/`),
    ),
    [],
  );
  assert.deepEqual(
    focused.map(rejectsCounterexample).filter((detail) => detail !== null),
    [],
  );
});

test('allowedWrites names exactly the paths the solution touches', () => {
  assert.deepEqual(
    cases.map((c) => [c.id, touched(c)]),
    cases.map((c) => [c.id, [...c.grade.allowedWrites].sort()]),
  );
});

test('the preserved smoke cases retain their read-only and writing split', () => {
  assert.deepEqual(
    {
      readOnly: idsWhere(
        (c) => c.suite === 'smoke' && c.grade.allowedWrites.length === 0,
      ),
      writing: idsWhere(
        (c) => c.suite === 'smoke' && c.grade.allowedWrites.length > 0,
      ),
    },
    {readOnly: READ_ONLY, writing: WRITING},
  );
});

test('every answers pattern matches its own case expected answer', () => {
  assert.deepEqual(
    cases.flatMap((c) =>
      answerPatterns(c)
        .filter((pattern) => {
          const expected = c.grade.expectedAnswer;
          return expected === undefined || !new RegExp(pattern).test(expected);
        })
        .map(
          (pattern) =>
            `${c.id}: /${pattern}/ against ${c.grade.expectedAnswer ?? 'no expectedAnswer'}`,
        ),
    ),
    [],
  );
});

test('a case carries an expected answer exactly when it has an answers check', () => {
  assert.deepEqual(
    idsWhere(
      (c) => (c.grade.expectedAnswer !== undefined) !== (answerPatterns(c).length > 0),
    ),
    [],
  );
});

test('a prompted check appears only in a guard case', () => {
  assert.deepEqual(
    idsWhere(
      (c) =>
        c.category !== 'guard' &&
        c.grade.checks.some((check) => check.kind === 'prompted'),
    ),
    [],
  );
});

test('every workspace holds files and none of them nests a solution directory', () => {
  assert.deepEqual(
    {
      empty: idsWhere((c) => readdirSync(join(c.dir, 'workspace')).length === 0),
      nested: idsWhere((c) => existsSync(join(c.dir, 'workspace', 'solution'))),
    },
    {empty: [], nested: []},
  );
});

test('every case names a positive maxSeconds and a legal mode and policy', () => {
  assert.deepEqual(
    idsWhere(
      (c) =>
        c.task.maxSeconds < 1 ||
        !isMode(c.task.mode) ||
        !POLICIES.includes(c.task.policy),
    ),
    [],
  );
});

test('only ask-edits-stops-a-write asks and every other case auto-edits', () => {
  assert.deepEqual(
    {
      askEdits: idsWhere((c) => c.task.mode === 'ask-edits'),
      neither: idsWhere(
        (c) => c.task.mode !== 'ask-edits' && c.task.mode !== 'auto-edits',
      ),
    },
    {
      askEdits: ['ask-edits-stops-a-write'],
      neither: [],
    },
  );
});

test('tool checks appear only in the three procedural focused cases', () => {
  assert.deepEqual(
    idsWhere((c) => c.grade.checks.some((check) => check.kind === 'tool')),
    ['bash-tail-diagnostic', 'recover-wrong-command', 'verify-after-fix'],
  );
});

test('focused cases do not contain dependency installs or network commands', () => {
  const banned = /\b(?:npm\s+(?:i|install)|pnpm\s+(?:add|install)|yarn\s+add|npx|curl|wget)\b|https?:\/\//i;
  assert.deepEqual(
    cases
      .filter((c) => c.suite === 'focused')
      .flatMap((c) => {
        const caseFile = readFileSync(join(c.dir, 'case.json'), 'utf8');
        const packageFile = join(c.dir, 'workspace', 'package.json');
        const packageText = existsSync(packageFile) ? readFileSync(packageFile, 'utf8') : '';
        return banned.test(`${caseFile}\n${packageText}`) ? [c.id] : [];
      }),
    [],
  );
});
