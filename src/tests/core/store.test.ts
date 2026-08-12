import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import type {Usage} from '../../core/host.js';
import {
  evictSessions,
  listSessions,
  loadSession,
  openSession,
  projectDir,
  SESSION_KEEP,
  startSession,
} from '../../core/store.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function home(): string {
  return tempDir('acc-home-');
}

function workspace(): string {
  return tempDir('acc-work-');
}

function user(text: string): OpenAI.ChatCompletionMessageParam {
  return {role: 'user', content: text};
}

function assistant(text: string): OpenAI.ChatCompletionMessageParam {
  return {role: 'assistant', content: text};
}

function usage(total: number): Usage {
  return {prompt: total, completion: 0, total};
}

function at(iso: string): () => Date {
  const fixed = new Date(iso);
  return () => fixed;
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

test('a session lands under its project, one file per turn', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendTurn([user('one')], usage(10));
  store.appendTurn([assistant('two')], usage(20));
  store.close();

  const project = projectDir(work, root);
  assert.equal(path.basename(path.dirname(store.dir)), 'sessions');
  assert.equal(path.dirname(path.dirname(store.dir)), project);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, 'project.json'), 'utf8')),
    {path: work},
  );
  const turns = fs
    .readdirSync(store.dir)
    .filter((name) => /^\d{4}\.json$/.test(name))
    .sort();
  assert.deepEqual(turns, ['0001.json', '0002.json']);
});

test('resume restores the messages and the token count', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendTurn([user('fix the cart'), assistant('on it')], usage(15));
  store.appendTurn([user('and the total'), assistant('done')], usage(28));
  store.close();

  const restored = loadSession(work, null, root);

  assert.deepEqual(restored.messages, [
    user('fix the cart'),
    assistant('on it'),
    user('and the total'),
    assistant('done'),
  ]);
  assert.equal(restored.meta.usage.total, 43);
  assert.equal(restored.meta.status, 'closed');
  assert.equal(restored.meta.workspace, work);
  assert.equal(restored.meta.id, store.id);
});

test('resume refuses a session from another folder', () => {
  const root = home();
  const mine = workspace();
  const other = workspace();
  const store = startSession(mine, root);
  store.appendTurn([user('hello')], usage(5));
  store.close();

  assert.throws(() => loadSession(other, store.id, root), /another folder/);
});

test('the newest session is the one resumed', () => {
  const root = home();
  const work = workspace();
  const older = startSession(work, root, at('2026-08-10T09:00:00Z'));
  older.appendTurn([user('old')], usage(5));
  older.close();
  const newer = startSession(work, root, at('2026-08-11T09:00:00Z'));
  newer.appendTurn([user('new')], usage(5));
  newer.close();

  assert.equal(loadSession(work, null, root).meta.id, newer.id);
  assert.deepEqual(
    listSessions(work, root).map((meta) => meta.id),
    [newer.id, older.id],
  );
});

test('a session is not readable by anyone else', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  store.appendTurn([user('a password lives in here')], usage(5));
  store.close();

  assert.equal(mode(projectDir(work, root)), 0o700);
  assert.equal(mode(store.dir), 0o700);
  assert.equal(mode(path.join(store.dir, 'session.json')), 0o600);
  assert.equal(mode(path.join(store.dir, '0001.json')), 0o600);
});

test('an old session is evicted, a recent one is kept', () => {
  const root = home();
  const work = workspace();
  const old = startSession(work, root, at('2026-06-01T10:00:00Z'));
  old.appendTurn([user('old')], usage(5));
  old.close();
  const recent = startSession(work, root, at('2026-08-09T10:00:00Z'));
  recent.appendTurn([user('recent')], usage(5));
  recent.close();

  const removed = evictSessions(root, new Date('2026-08-11T10:00:00Z'), 1);

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(old.dir), false);
  assert.deepEqual(
    listSessions(work, root).map((meta) => meta.id),
    [recent.id],
  );
});

test('the newest fifty survive whatever their age', () => {
  const root = home();
  const work = workspace();
  const start = new Date('2020-01-01T00:00:00Z').getTime();
  const ids: string[] = [];
  for (let n = 0; n < SESSION_KEEP + 5; n += 1) {
    const store = startSession(
      work,
      root,
      at(new Date(start + n * 60_000).toISOString()),
    );
    store.appendTurn([user(`session ${n}`)], usage(1));
    store.close();
    ids.push(store.id);
  }

  evictSessions(root, new Date('2026-08-11T10:00:00Z'));

  const left = listSessions(work, root).map((meta) => meta.id);
  assert.equal(left.length, SESSION_KEEP);
  assert.deepEqual(left, ids.slice(-SESSION_KEEP).reverse());
});

test('reopening a session keeps the folder and continues the numbering', () => {
  const root = home();
  const work = workspace();
  const first = startSession(work, root);
  first.appendTurn([user('fix the cart')], usage(15));
  first.appendView([{kind: 'task', text: 'fix the cart'}]);
  first.close();

  const {stored, store} = openSession(work, null, root);
  store.seed(stored.messages);
  store.appendTurn([...stored.messages, assistant('done')], usage(10));
  store.close();

  assert.equal(store.dir, first.dir);
  assert.deepEqual(fs.readdirSync(store.dir).sort(), [
    '0001.json',
    '0003.json',
    'session.json',
    'v0002.json',
  ]);
  const again = loadSession(work, null, root);
  assert.deepEqual(again.messages, [user('fix the cart'), assistant('done')]);
  assert.equal(again.meta.usage.total, 25);
  assert.equal(again.meta.id, first.id);
});

test('a reopened session is open again while it runs', () => {
  const root = home();
  const work = workspace();
  const first = startSession(work, root);
  first.appendTurn([user('hello')], usage(5));
  first.close();

  const {store} = openSession(work, null, root);
  assert.equal(loadSession(work, null, root).meta.status, 'open');
  store.close();
  assert.equal(loadSession(work, null, root).meta.status, 'closed');
});

test('seeded messages are never written twice', () => {
  const root = home();
  const work = workspace();
  const first = startSession(work, root);
  first.appendTurn([user('one'), assistant('two')], usage(5));
  first.close();

  const {stored, store} = openSession(work, null, root);
  store.seed(stored.messages);
  store.appendTurn(stored.messages, usage(0));
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    user('one'),
    assistant('two'),
  ]);
});

test('a folder with no sessions lists nothing', () => {
  assert.deepEqual(listSessions(workspace(), home()), []);
});

test('resuming a folder with no sessions says so', () => {
  assert.throws(() => loadSession(workspace(), null, home()), /no session/);
});
