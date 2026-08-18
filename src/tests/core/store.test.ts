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
  projectDir,
  SESSION_KEEP,
} from '../../core/projects.js';
import {checkpointsOf, lastUsageOf} from '../../core/records.js';
import {
  loadSession,
  openSession,
  startSession,
  type SessionMeta,
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

function records(dir: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(dir, 'session.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function legacySession(work: string, root: string, id: string): string {
  const dir = path.join(projectDir(work, root), 'sessions', id);
  fs.mkdirSync(dir, {recursive: true});
  const meta: SessionMeta = {
    version: 1,
    id,
    workspace: work,
    startedAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:30:00.000Z',
    status: 'closed',
    usage: {prompt: 10, completion: 5, total: 15},
    firstTask: 'an old conversation',
  };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, '0001.json'), JSON.stringify([user('old')]));
  return dir;
}

test('a session is one file of records', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('one')], usage(10));
  store.appendView([{kind: 'task', text: 'one'}]);
  store.appendStep([assistant('two')], usage(20));
  store.close();

  const project = projectDir(work, root);
  assert.equal(path.basename(path.dirname(store.dir)), 'sessions');
  assert.equal(path.dirname(path.dirname(store.dir)), project);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, 'project.json'), 'utf8')),
    {path: work},
  );
  assert.deepEqual(fs.readdirSync(store.dir).sort(), [
    'session.json',
    'session.jsonl',
  ]);
  assert.deepEqual(
    records(store.dir).map((record) => record['kind']),
    ['messages', 'view', 'messages'],
  );
});

test('reading a session returns both the messages and the view', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  store.appendStep([user('fix the cart'), assistant('on it')], usage(15));
  store.appendView([{kind: 'text', text: 'on it'}]);
  store.close();

  const restored = loadSession(work, null, root);

  assert.deepEqual(restored.messages, [user('fix the cart'), assistant('on it')]);
  assert.deepEqual(restored.view, [
    {kind: 'task', text: 'fix the cart'},
    {kind: 'text', text: 'on it'},
  ]);
});

test('a version 1 session is not loaded', () => {
  const root = home();
  const work = workspace();
  const old = legacySession(work, root, '20260810-090000-aaaabbbb');

  assert.throws(() => loadSession(work, null, root), /no session/);
  assert.throws(() => loadSession(work, '20260810-090000-aaaabbbb', root), /no session/);
  assert.deepEqual(listSessions(work, root), []);
  assert.equal(fs.existsSync(old), true);
});

test('a record of an unknown kind is ignored, not an error', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  store.appendStep([user('fix the cart')], usage(15));
  store.close();
  fs.appendFileSync(
    path.join(store.dir, 'session.jsonl'),
    `${JSON.stringify({kind: 'something-new', at: '9f3a1c07', files: {}})}\n`,
  );

  const restored = loadSession(work, null, root);

  assert.deepEqual(restored.messages, [user('fix the cart')]);
  assert.deepEqual(restored.view, []);
});

test('resume restores the messages and the token count', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('fix the cart'), assistant('on it')], usage(15));
  store.appendStep([user('and the total'), assistant('done')], usage(28));
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

test('the last usage is the newest turn, not the first', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  const first = user('fix the cart');
  store.appendMessage(first);
  store.appendStep([first, assistant('fixed')], usage(15));
  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  const second = user('and the readme');
  store.appendMessage(second);
  store.appendStep([second, assistant('updated')], usage(28));
  store.appendView([{kind: 'task', text: 'and the readme'}]);
  store.close();

  assert.deepEqual(lastUsageOf(store.records()), usage(28));
});

test('a session with no completed turn has no last usage', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendMessage(user('fix the cart'));
  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  store.close();

  assert.equal(lastUsageOf(store.records()), null);
});

test('resume refuses a session from another folder', () => {
  const root = home();
  const mine = workspace();
  const other = workspace();
  const store = startSession(mine, root);
  store.appendStep([user('hello')], usage(5));
  store.close();

  assert.throws(() => loadSession(other, store.id, root), /another folder/);
});

test('the newest session is the one resumed', () => {
  const root = home();
  const work = workspace();
  const older = startSession(work, root, at('2026-08-10T09:00:00Z'));
  older.appendStep([user('old')], usage(5));
  older.close();
  const newer = startSession(work, root, at('2026-08-11T09:00:00Z'));
  newer.appendStep([user('new')], usage(5));
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
  store.appendStep([user('a password lives in here')], usage(5));
  store.close();

  assert.equal(mode(projectDir(work, root)), 0o700);
  assert.equal(mode(store.dir), 0o700);
  assert.equal(mode(path.join(store.dir, 'session.json')), 0o600);
  assert.equal(mode(path.join(store.dir, 'session.jsonl')), 0o600);
});

test('an old session is evicted, a recent one is kept', () => {
  const root = home();
  const work = workspace();
  const old = startSession(work, root, at('2026-06-01T10:00:00Z'));
  old.appendStep([user('old')], usage(5));
  old.close();
  const recent = startSession(work, root, at('2026-08-09T10:00:00Z'));
  recent.appendStep([user('recent')], usage(5));
  recent.close();

  const removed = evictSessions(root, new Date('2026-08-11T10:00:00Z'), 1);

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(old.dir), false);
  assert.deepEqual(
    listSessions(work, root).map((meta) => meta.id),
    [recent.id],
  );
});

test('a session resumed today survives however old it is', () => {
  const root = home();
  const work = workspace();
  const old = startSession(work, root, at('2026-06-01T10:00:00Z'));
  old.appendStep([user('old')], usage(5));
  old.close();
  const filler = startSession(work, root, at('2026-08-09T10:00:00Z'));
  filler.appendStep([user('filler')], usage(5));
  filler.close();

  const {store} = openSession(work, old.id, root, at('2026-08-11T09:00:00Z'));
  store.close();
  const removed = evictSessions(root, new Date('2026-08-11T10:00:00Z'), 1);

  assert.equal(removed, 0);
  assert.equal(fs.existsSync(old.dir), true);
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
    store.appendStep([user(`session ${n}`)], usage(1));
    store.close();
    ids.push(store.id);
  }

  evictSessions(root, new Date('2026-08-11T10:00:00Z'));

  const left = listSessions(work, root).map((meta) => meta.id);
  assert.equal(left.length, SESSION_KEEP);
  assert.deepEqual(left, ids.slice(-SESSION_KEEP).reverse());
});

test('reopening a session keeps the folder and appends to the same file', () => {
  const root = home();
  const work = workspace();
  const first = startSession(work, root);
  first.appendStep([user('fix the cart')], usage(15));
  first.appendView([{kind: 'task', text: 'fix the cart'}]);
  first.close();

  const {stored, store} = openSession(work, null, root);
  store.seed(stored.messages);
  store.appendStep([...stored.messages, assistant('done')], usage(10));
  store.close();

  assert.equal(store.dir, first.dir);
  assert.deepEqual(fs.readdirSync(store.dir).sort(), [
    'session.json',
    'session.jsonl',
  ]);
  assert.deepEqual(
    records(store.dir).map((record) => record['kind']),
    ['messages', 'view', 'messages'],
  );
  const again = loadSession(work, null, root);
  assert.deepEqual(again.messages, [user('fix the cart'), assistant('done')]);
  assert.equal(again.meta.usage.total, 25);
  assert.equal(again.meta.id, first.id);
});

test('a reopened session is open again while it runs', () => {
  const root = home();
  const work = workspace();
  const first = startSession(work, root);
  first.appendStep([user('hello')], usage(5));
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
  first.appendStep([user('one'), assistant('two')], usage(5));
  first.close();

  const {stored, store} = openSession(work, null, root);
  store.seed(stored.messages);
  store.appendStep(stored.messages, usage(0));
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    user('one'),
    assistant('two'),
  ]);
});

test('every user message record carries an id', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  const asked = user('fix the cart');

  store.appendMessage(asked);
  store.appendStep([asked, assistant('on it')], usage(15));
  store.close();

  const [first, second] = records(store.dir);
  assert.equal(first!['kind'], 'message');
  assert.match(String(first!['id']), /^[0-9a-f]{8}$/);
  assert.deepEqual(second!['messages'], [assistant('on it')]);
  assert.deepEqual(loadSession(work, null, root).messages, [
    user('fix the cart'),
    assistant('on it'),
  ]);
});

test('a task is on disk before the turn that answers it', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendMessage(user('fix the cart'));

  const restored = loadSession(work, null, root);
  assert.deepEqual(restored.messages, [user('fix the cart')]);
  assert.equal(listSessions(work, root)[0]!.firstTask, 'fix the cart');
});

function twoTasks(store: ReturnType<typeof startSession>): void {
  const one = user('fix the cart');
  store.appendMessage(one);
  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  store.appendStep([one, assistant('fixed')], usage(10));
  const two = user('and the readme');
  store.appendMessage(two);
  store.appendView([{kind: 'task', text: 'and the readme'}]);
  store.appendStep([two, assistant('updated')], usage(20));
}

test('a rewind drops the records above the cut', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  twoTasks(store);

  store.rewind(3);
  store.close();

  const restored = loadSession(work, null, root);
  assert.deepEqual(restored.messages, [user('fix the cart'), assistant('fixed')]);
  assert.deepEqual(restored.view, [{kind: 'task', text: 'fix the cart'}]);
  assert.equal(store.records().length, 3);
  assert.equal(restored.meta.usage.total, 30);
});

test('a rewind leaves the dropped records in the file', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  twoTasks(store);

  store.rewind(3);
  store.close();

  const written = records(store.dir);
  assert.equal(written.length, 7);
  assert.deepEqual(written[6], {kind: 'rewind', to: 3});
  assert.deepEqual(
    written.slice(3, 6).map((record) => record['kind']),
    ['message', 'view', 'messages'],
  );
});

test('a second rewind cuts from what the first one left', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  twoTasks(store);

  store.rewind(3);
  store.rewind(1);
  store.close();

  const restored = loadSession(work, null, root);
  assert.deepEqual(restored.messages, [user('fix the cart')]);
  assert.deepEqual(restored.view, []);
  assert.equal(store.records().length, 1);
});

test('the next append after a rewind continues from the cut', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  twoTasks(store);

  store.rewind(3);
  const again = user('try once more');
  store.appendMessage(again);
  store.appendStep([again, assistant('done')], usage(5));
  store.close();

  const restored = loadSession(work, null, root);
  assert.deepEqual(restored.messages, [
    user('fix the cart'),
    assistant('fixed'),
    user('try once more'),
    assistant('done'),
  ]);
  assert.deepEqual(fs.readdirSync(store.dir).sort(), [
    'session.json',
    'session.jsonl',
  ]);
  assert.equal(store.records().length, 5);
});

test('a file version is one record in the log', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendCode('src/a.ts', 'f1e2d3');
  store.appendCode('src/new.ts', null);
  store.close();

  assert.deepEqual(records(store.dir), [
    {kind: 'code', path: 'src/a.ts', before: 'f1e2d3'},
    {kind: 'code', path: 'src/new.ts', before: null},
  ]);
  assert.deepEqual(store.records(), [
    {kind: 'code', path: 'src/a.ts', before: 'f1e2d3'},
    {kind: 'code', path: 'src/new.ts', before: null},
  ]);
});

test('a file version changes neither the conversation nor the screen', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  const asked = user('fix the cart');
  store.appendMessage(asked);
  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  store.appendCode('src/cart.ts', 'f1e2d3');
  store.appendStep([asked, assistant('fixed')], usage(10));
  store.appendMessage(user('and the readme'));
  store.close();

  const restored = loadSession(work, null, root);

  assert.deepEqual(restored.messages, [
    user('fix the cart'),
    assistant('fixed'),
    user('and the readme'),
  ]);
  assert.deepEqual(restored.view, [{kind: 'task', text: 'fix the cart'}]);
  assert.deepEqual(
    checkpointsOf(store.records()).map((checkpoint) => checkpoint.at),
    [0, 4],
  );
});

test('a rewind drops the file versions above the cut and keeps those below', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  const first = user('fix the cart');
  store.appendMessage(first);
  store.appendCode('src/cart.ts', 'aaaa');
  store.appendStep([first, assistant('fixed')], usage(10));
  const second = user('and the readme');
  store.appendMessage(second);
  store.appendCode('README.md', null);
  store.appendStep([second, assistant('updated')], usage(20));

  store.rewind(3);
  store.close();

  assert.deepEqual(
    store.records().filter((record) => record.kind === 'code'),
    [{kind: 'code', path: 'src/cart.ts', before: 'aaaa'}],
  );
  assert.equal(store.records().length, 3);
});

function askedAt(
  store: ReturnType<typeof startSession>,
  at: number,
): OpenAI.ChatCompletionMessageParam | null {
  const record = store.records()[at];
  return record && record.kind === 'message' ? record.message : null;
}

test('a compaction drops everything before it and leaves the summary', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('fix the cart'), assistant('fixed')], usage(10));
  store.appendStep([user('and the readme'), assistant('updated')], usage(20));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 4);
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    assistant('SUMMARY: we fixed the cart'),
  ]);
});

test('what is said after a compaction follows the summary', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('fix the cart'), assistant('fixed')], usage(10));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 2);
  const next = user('and the readme');
  store.appendMessage(next);
  store.appendStep([next, assistant('updated')], usage(20));
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    assistant('SUMMARY: we fixed the cart'),
    user('and the readme'),
    assistant('updated'),
  ]);
});

test('the checkpoints reach back past a compaction', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendMessage(user('fix the cart'));
  store.appendMessage(user('and the total'));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 2);
  store.appendMessage(user('and the readme'));
  store.appendMessage(user('and the changelog'));
  store.close();

  const checkpoints = checkpointsOf(store.records());

  assert.equal(checkpoints.length, 4);
  assert.deepEqual(
    checkpoints.map((checkpoint) => askedAt(store, checkpoint.at)),
    [
      user('fix the cart'),
      user('and the total'),
      user('and the readme'),
      user('and the changelog'),
    ],
  );
});

test('a rewind after a compaction can land before the summary', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  const first = user('fix the cart');
  store.appendMessage(first);
  store.appendStep([first, assistant('fixed')], usage(10));
  const second = user('and the total');
  store.appendMessage(second);
  store.appendStep([second, assistant('counted')], usage(20));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 4);
  store.appendMessage(user('and the readme'));

  const [, middle] = checkpointsOf(store.records());
  store.rewind(middle!.at);
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    user('fix the cart'),
    assistant('fixed'),
  ]);
});

test('the last usage is not read across a compaction', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('fix the cart'), assistant('fixed')], usage(15));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 2);

  assert.equal(lastUsageOf(store.records()), null);

  store.appendStep([user('and the readme'), assistant('updated')], usage(28));
  store.close();

  assert.deepEqual(lastUsageOf(store.records()), usage(28));
});

test('a summary handed back to the next turn is not written twice', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);
  const summary = assistant('SUMMARY: we fixed the cart');

  store.appendStep([user('fix the cart'), assistant('fixed')], usage(10));
  store.appendCompact(summary, 2);
  store.appendStep([summary, user('next'), assistant('done')], usage(10));
  store.close();

  const written = records(store.dir);
  const restored = loadSession(work, null, root);

  assert.equal(
    restored.messages.filter(
      (message) => message.content === 'SUMMARY: we fixed the cart',
    ).length,
    1,
  );
  assert.equal(written.filter((record) => record['kind'] === 'compact').length, 1);
  assert.deepEqual(
    written
      .filter((record) => record['kind'] === 'messages')
      .flatMap((record) => record['messages'] as unknown[]),
    [user('fix the cart'), assistant('fixed'), user('next'), assistant('done')],
  );
});

test('an unknown record next to a compaction is still ignored', () => {
  const root = home();
  const work = workspace();
  const store = startSession(work, root);

  store.appendStep([user('fix the cart'), assistant('fixed')], usage(10));
  store.appendCompact(assistant('SUMMARY: we fixed the cart'), 2);
  fs.appendFileSync(
    path.join(store.dir, 'session.jsonl'),
    `${JSON.stringify({kind: 'something-new', at: '9f3a1c07', note: 'later'})}\n`,
  );
  store.appendStep([user('and the readme'), assistant('updated')], usage(20));
  store.close();

  assert.deepEqual(loadSession(work, null, root).messages, [
    assistant('SUMMARY: we fixed the cart'),
    user('and the readme'),
    assistant('updated'),
  ]);
});

test('a folder with no sessions lists nothing', () => {
  assert.deepEqual(listSessions(workspace(), home()), []);
});

test('resuming a folder with no sessions says so', () => {
  assert.throws(() => loadSession(workspace(), null, home()), /no session/);
});
