import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import type {TaskCase} from './cases.js';
import {
  applySolution,
  buildFixture,
  changes,
  FIXTURE_PREFIX,
  hashFile,
  removeFixture,
  snapshot,
} from './fixture.js';

type Files = Record<string, string>;

function write(root: string, files: Files): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
}

function tree(t: TestContext, files: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-tree-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  write(root, files);
  return root;
}

function taskCase(dir: string): TaskCase {
  return {
    id: 'fixture-case',
    category: 'edit',
    task: {
      prompt: 'rename the greeting',
      mode: 'auto-edits',
      policy: 'yes',
      maxSeconds: 60,
    },
    grade: {
      allowedWrites: ['a.txt'],
      checks: [{kind: 'exists', path: 'a.txt'}],
    },
    dir,
  };
}

function caseWith(t: TestContext, workspace: Files, solution?: Files): TaskCase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-case-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'workspace'), {recursive: true});
  write(path.join(dir, 'workspace'), workspace);
  if (solution !== undefined) write(path.join(dir, 'solution'), solution);
  return taskCase(dir);
}

function fixture(t: TestContext, c: TaskCase): string {
  const root = buildFixture(c);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function contents(root: string): Files {
  return Object.fromEntries(
    [...snapshot(root).keys()].map((relative) => [
      relative,
      fs.readFileSync(path.join(root, relative), 'utf8'),
    ]),
  );
}

test('a nested workspace arrives in the fixture file for file', (t) => {
  const files = {
    'a.txt': 'alpha\n',
    'src/b.js': 'export const b = 1;\n',
    'src/deep/c.md': '# deep\n',
  };

  const root = fixture(t, caseWith(t, files));

  assert.deepEqual(contents(root), files);
});

test('the fixture is a temp copy, so editing it leaves the case untouched', (t) => {
  const c = caseWith(t, {'a.txt': 'alpha\n'});
  const root = fixture(t, c);

  fs.writeFileSync(path.join(root, 'a.txt'), 'edited\n');

  assert.equal(root.startsWith(os.tmpdir()), true);
  assert.equal(path.basename(root).startsWith(FIXTURE_PREFIX), true);
  assert.notEqual(root, path.join(c.dir, 'workspace'));
  assert.equal(
    fs.readFileSync(path.join(c.dir, 'workspace', 'a.txt'), 'utf8'),
    'alpha\n',
  );
});

test('snapshotting a tree that did not change hashes it the same both times', (t) => {
  const root = tree(t, {'a.txt': 'alpha\n', 'src/deep/c.md': '# deep\n'});

  const first = snapshot(root);

  assert.deepEqual(snapshot(root), first);
  assert.equal(first.get('a.txt'), hashFile(path.join(root, 'a.txt')));
});

test('a file with new contents is modified, neither added nor deleted', (t) => {
  const root = tree(t, {'a.txt': 'alpha\n', 'src/b.js': 'const b = 1;\n'});
  const before = snapshot(root);

  fs.writeFileSync(path.join(root, 'src/b.js'), 'const b = 2;\n');

  assert.deepEqual(changes(before, snapshot(root)), {
    added: [],
    modified: ['src/b.js'],
    deleted: [],
  });
});

test('a file that was not there before is added', (t) => {
  const root = tree(t, {'a.txt': 'alpha\n'});
  const before = snapshot(root);

  write(root, {'src/new.js': 'const n = 1;\n'});

  assert.deepEqual(changes(before, snapshot(root)), {
    added: ['src/new.js'],
    modified: [],
    deleted: [],
  });
});

test('a file that is gone afterwards is deleted', (t) => {
  const root = tree(t, {'a.txt': 'alpha\n', 'src/b.js': 'const b = 1;\n'});
  const before = snapshot(root);

  fs.rmSync(path.join(root, 'src/b.js'));

  assert.deepEqual(changes(before, snapshot(root)), {
    added: [],
    modified: [],
    deleted: ['src/b.js'],
  });
});

test('all three lists come back sorted whatever order the hashes came in', () => {
  const before = new Map([
    ['y.txt', 'one'],
    ['b.txt', 'one'],
    ['m.txt', 'one'],
    ['c.txt', 'one'],
  ]);
  const after = new Map([
    ['m.txt', 'two'],
    ['c.txt', 'two'],
    ['z.txt', 'one'],
    ['a.txt', 'one'],
  ]);

  assert.deepEqual(changes(before, after), {
    added: ['a.txt', 'z.txt'],
    modified: ['c.txt', 'm.txt'],
    deleted: ['b.txt', 'y.txt'],
  });
});

test('the solution overwrites the files it names and adds the rest', (t) => {
  const c = caseWith(
    t,
    {'a.txt': 'alpha\n', 'notes.md': 'untouched\n', 'src/b.js': 'const b = 1;\n'},
    {'a.txt': 'fixed\n', 'src/c.js': 'const c = 3;\n'},
  );
  const root = fixture(t, c);

  applySolution(c, root);

  assert.deepEqual(contents(root), {
    'a.txt': 'fixed\n',
    'notes.md': 'untouched\n',
    'src/b.js': 'const b = 1;\n',
    'src/c.js': 'const c = 3;\n',
  });
});

test('a case with no solution directory leaves the fixture exactly as built', (t) => {
  const c = caseWith(t, {'a.txt': 'alpha\n', 'src/b.js': 'const b = 1;\n'});
  const root = fixture(t, c);
  const before = snapshot(root);

  applySolution(c, root);

  assert.deepEqual(snapshot(root), before);
});

test('dotfiles and dotted directories are hashed like any other file', (t) => {
  const root = tree(t, {
    'a.txt': 'alpha\n',
    '.env': 'KEY=1\n',
    '.acc/settings.json': '{}\n',
  });

  assert.deepEqual(
    [...snapshot(root).keys()],
    ['.acc/settings.json', '.env', 'a.txt'],
  );
});

test('removing a fixture deletes the tree and removing it again is quiet', (t) => {
  const root = fixture(t, caseWith(t, {'a.txt': 'alpha\n', 'src/b.js': 'const b = 1;\n'}));

  removeFixture(root);
  removeFixture(root);

  assert.equal(fs.existsSync(root), false);
});
