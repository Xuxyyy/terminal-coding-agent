import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {isMode} from '../../core/permission/mode.js';
import {loadCases, POLICIES, type Category, type TaskCase} from './cases.js';
import {
  applySolution,
  buildFixture,
  changes,
  removeFixture,
  snapshot,
} from './fixture.js';
import {runChecks} from './grade.js';
import {DEFAULT_CASES} from './run.js';

const cases: TaskCase[] = loadCases(resolve(process.cwd(), DEFAULT_CASES));

const EXPECTED_CATEGORY: Record<string, Category> = {
  'fix-failing-test': 'edit',
  'no-deleting-the-test': 'restraint',
  'rename-across-files': 'edit',
  'create-to-spec': 'create',
  'answer-needs-grep': 'find',
  'already-done': 'restraint',
  'ask-edits-stops-a-write': 'guard',
  'outside-the-root': 'guard',
  'read-truncation-repair': 'recover',
  'grep-narrow': 'recover',
};

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
    return runChecks(c, root, '', before)
      .filter(
        (result) =>
          result.check.kind !== 'answers' && result.check.kind !== 'prompted',
      )
      .filter((result) => !result.ok)
      .map((result) => `${c.id}: ${result.detail}`);
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

test('the whole set loads and holds ten cases', () => {
  assert.equal(cases.length, 10);
});

test('the ids and categories are the ones the plan named', () => {
  assert.deepEqual(
    Object.fromEntries(cases.map((c) => [c.id, c.category])),
    EXPECTED_CATEGORY,
  );
});

test('every reference solution satisfies its own case file-state checks', () => {
  assert.deepEqual(cases.flatMap(solved), []);
});

test('allowedWrites names exactly the paths the solution touches', () => {
  assert.deepEqual(
    cases.map((c) => [c.id, touched(c)]),
    cases.map((c) => [c.id, [...c.grade.allowedWrites].sort()]),
  );
});

test('six cases may change nothing and four may write', () => {
  assert.deepEqual(
    {
      readOnly: idsWhere((c) => c.grade.allowedWrites.length === 0),
      writing: idsWhere((c) => c.grade.allowedWrites.length > 0),
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

test('only ask-edits-stops-a-write asks, the rest auto-edit, and every case denies', () => {
  assert.deepEqual(
    {
      askEdits: idsWhere((c) => c.task.mode === 'ask-edits'),
      neither: idsWhere(
        (c) => c.task.mode !== 'ask-edits' && c.task.mode !== 'auto-edits',
      ),
      policies: [...new Set(cases.map((c) => c.task.policy))],
    },
    {
      askEdits: ['ask-edits-stops-a-write'],
      neither: [],
      policies: ['deny'],
    },
  );
});
