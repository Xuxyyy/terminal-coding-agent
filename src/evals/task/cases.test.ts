import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {loadCase, loadCases} from './cases.js';

type Raw = Record<string, unknown>;

function raw(overrides: Raw = {}): Raw {
  return {
    id: 'fix-failing-test',
    suite: 'smoke',
    category: 'edit',
    task: {
      prompt: 'make the test pass',
      mode: 'auto-edits',
      policy: 'deny',
      maxSeconds: 120,
    },
    grade: {
      allowedWrites: ['src/sum.js'],
      checks: [
        {kind: 'exit0', command: 'node --test test/'},
        {kind: 'unchanged', path: 'test/sum.test.js'},
      ],
    },
    ...overrides,
  };
}

function root(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-task-cases-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function writeCase(
  root: string,
  name: string,
  body: Raw | string,
  workspace = true,
): string {
  const dir = join(root, name);
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, 'case.json'),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
  if (workspace) mkdirSync(join(dir, 'workspace'));
  return dir;
}

function oneCase(t: TestContext, body: Raw | string, workspace = true): string {
  return writeCase(root(t), 'a-case', body, workspace);
}

function complaint(dir: string, detail: string): RegExp {
  const where = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^CaseError: ${where}: ${detail}$`);
}

test('a valid case round trips', (t) => {
  const dir = oneCase(t, raw());

  assert.deepEqual(loadCase(dir), {
    id: 'fix-failing-test',
    suite: 'smoke',
    category: 'edit',
    task: {
      prompt: 'make the test pass',
      mode: 'auto-edits',
      policy: 'deny',
      maxSeconds: 120,
    },
    grade: {
      allowedWrites: ['src/sum.js'],
      checks: [
        {kind: 'exit0', command: 'node --test test/'},
        {kind: 'unchanged', path: 'test/sum.test.js'},
      ],
    },
    dir,
  });
});

test('a case with no workspace directory names the case directory', (t) => {
  const dir = oneCase(t, raw(), false);

  assert.throws(() => loadCase(dir), complaint(dir, 'has no workspace/ directory'));
});

test('malformed json in case.json is rejected', (t) => {
  const dir = oneCase(t, '{"id": "fix-failing-test",}');

  assert.throws(() => loadCase(dir), /^CaseError: .*: case\.json is not valid JSON — /);
});

test('an unknown check kind lists the legal kinds', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {allowedWrites: [], checks: [{kind: 'passes', path: 'src/sum.js'}]},
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(
      dir,
      'grade\\.checks\\[0\\]: kind must be one of ' +
        'exit0, exists, absent, contains, matches, unchanged, answers, prompted, tool',
    ),
  );
});

test('an unknown category lists the legal categories', (t) => {
  const dir = oneCase(t, raw({category: 'refactor'}));

  assert.throws(
    () => loadCase(dir),
    complaint(
      dir,
      'category must be one of edit, find, create, restraint, guard, recover',
    ),
  );
});

test('a mode outside the three permission modes is rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      task: {prompt: 'go', mode: 'yolo', policy: 'deny', maxSeconds: 60},
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(dir, 'task\\.mode is "yolo"; use ask-edits, auto-edits, auto'),
  );
});

test('a policy outside deny and yes is rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      task: {prompt: 'go', mode: 'auto', policy: 'ask', maxSeconds: 60},
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(dir, 'task\\.policy is "ask"; use deny, yes'),
  );
});

test('an absolute allowed write is rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {
        allowedWrites: ['/etc/passwd'],
        checks: [{kind: 'exists', path: 'src/sum.js'}],
      },
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(dir, "grade\\.allowedWrites '/etc/passwd' must be workspace-relative"),
  );
});

test('an allowed write that climbs out with .. is rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {
        allowedWrites: ['src/../../outside.js'],
        checks: [{kind: 'exists', path: 'src/sum.js'}],
      },
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(
      dir,
      "grade\\.allowedWrites 'src/\\.\\./\\.\\./outside\\.js' " +
        "must not climb out with '\\.\\.'",
    ),
  );
});

test('an answers check with an unparseable pattern is rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {allowedWrites: [], checks: [{kind: 'answers', pattern: '('}]},
    }),
  );

  assert.throws(
    () => loadCase(dir),
    /^CaseError: .*: grade\.checks\[0\]: pattern is not a regex — /,
  );
});

test('expectedAnswer stays absent when the json omits it', (t) => {
  const dir = oneCase(t, raw());

  assert.equal('expectedAnswer' in loadCase(dir).grade, false);
});

test('two cases sharing an id name the duplicate id', (t) => {
  const dir = root(t);
  writeCase(dir, 'first', raw({id: 'twin'}));
  writeCase(dir, 'second', raw({id: 'twin'}));

  assert.throws(
    () => loadCases(dir),
    complaint(join(dir, 'second'), "duplicate id 'twin', first used by first"),
  );
});

test('loadCases returns the cases sorted by directory name', (t) => {
  const dir = root(t);
  writeCase(dir, 'zebra', raw({id: 'z'}));
  writeCase(dir, 'alpha', raw({id: 'a'}));
  writeCase(dir, 'middle', raw({id: 'm'}));

  assert.deepEqual(
    loadCases(dir).map((entry) => [entry.id, entry.dir]),
    [
      ['a', join(dir, 'alpha')],
      ['m', join(dir, 'middle')],
      ['z', join(dir, 'zebra')],
    ],
  );
});

test('a prompted check carries no fields beyond its kind', (t) => {
  const dir = oneCase(
    t,
    raw({
      category: 'guard',
      grade: {
        allowedWrites: [],
        checks: [{kind: 'prompted'}, {kind: 'exists', path: 'src/sum.js'}],
      },
    }),
  );

  assert.deepEqual(loadCase(dir).grade.checks, [
    {kind: 'prompted'},
    {kind: 'exists', path: 'src/sum.js'},
  ]);
});

test('an absolute path on a check is accepted', (t) => {
  const dir = oneCase(
    t,
    raw({
      category: 'guard',
      grade: {
        allowedWrites: [],
        checks: [{kind: 'absent', path: '/tmp/acc-eval-outside.txt'}],
      },
    }),
  );

  assert.deepEqual(loadCase(dir).grade.checks, [
    {kind: 'absent', path: '/tmp/acc-eval-outside.txt'},
  ]);
});

test('a check path that climbs out with .. is still rejected', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {
        allowedWrites: [],
        checks: [{kind: 'contains', path: '../outside.txt', text: 'hi'}],
      },
    }),
  );

  assert.throws(
    () => loadCase(dir),
    complaint(
      dir,
      "grade\\.checks\\[0\\]: path '\\.\\./outside\\.txt' " +
        "must not climb out with '\\.\\.'",
    ),
  );
});

test('all three suites are accepted and an unknown suite is rejected', (t) => {
  for (const suite of ['smoke', 'focused', 'workflow']) {
    const dir = oneCase(t, raw({suite}));
    assert.equal(loadCase(dir).suite, suite);
  }
  const dir = oneCase(t, raw({suite: 'benchmark'}));
  assert.throws(
    () => loadCase(dir),
    complaint(dir, 'suite must be one of smoke, focused, workflow'),
  );
});

test('a tool check keeps its name and optional argument and result patterns', (t) => {
  const dir = oneCase(
    t,
    raw({
      grade: {
        allowedWrites: [],
        checks: [
          {
            kind: 'tool',
            name: 'bash',
            argsPattern: 'node --test',
            resultPattern: '\\[exit 0\\]',
          },
        ],
      },
    }),
  );

  assert.deepEqual(loadCase(dir).grade.checks, [
    {
      kind: 'tool',
      name: 'bash',
      argsPattern: 'node --test',
      resultPattern: '\\[exit 0\\]',
    },
  ]);
});

test('a tool check rejects invalid optional regexes at load time', (t) => {
  for (const key of ['argsPattern', 'resultPattern']) {
    const dir = oneCase(
      t,
      raw({
        grade: {
          allowedWrites: [],
          checks: [{kind: 'tool', name: 'bash', [key]: '('}],
        },
      }),
    );
    assert.throws(
      () => loadCase(dir),
      new RegExp(`grade\\.checks\\[0\\]: ${key} is not a regex`),
    );
  }
});

test('counterexampleAnswer is optional but must be a non-empty string', (t) => {
  const present = oneCase(
    t,
    raw({grade: {allowedWrites: [], checks: [{kind: 'answers', pattern: 'right'}], counterexampleAnswer: 'wrong'}}),
  );
  assert.equal(loadCase(present).grade.counterexampleAnswer, 'wrong');

  const invalid = oneCase(
    t,
    raw({grade: {allowedWrites: [], checks: [{kind: 'answers', pattern: 'right'}], counterexampleAnswer: ''}}),
  );
  assert.throws(
    () => loadCase(invalid),
    complaint(invalid, 'grade\.counterexampleAnswer must be a non-empty string'),
  );
});

test('duplicate ids are rejected even when their suites differ', (t) => {
  const dir = root(t);
  writeCase(dir, 'first', raw({id: 'same', suite: 'smoke'}));
  writeCase(dir, 'second', raw({id: 'same', suite: 'focused'}));

  assert.throws(
    () => loadCases(dir),
    complaint(join(dir, 'second'), "duplicate id 'same', first used by first"),
  );
});
