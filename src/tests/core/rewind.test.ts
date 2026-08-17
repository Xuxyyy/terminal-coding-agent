import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import {captureBefore, filesDir} from '../../core/history.js';
import {checkpointsOf} from '../../core/records.js';
import {rewindSession} from '../../core/rewind.js';
import {
  addTask,
  createSession,
  recordUsage,
  restoreMessages,
  type Session,
} from '../../core/session.js';
import {openSession, startSession} from '../../core/store.js';

function conversation(): Session {
  const session = createSession('/tmp/work', 'rules', 1_000);
  addTask(session, 'fix the cart');
  session.messages.push({role: 'assistant', content: 'fixed'});
  addTask(session, 'update the readme');
  session.messages.push({role: 'assistant', content: 'updated'});
  addTask(session, 'handle an empty cart');
  session.messages.push({role: 'assistant', content: 'handled'});
  return session;
}

function texts(session: Session): unknown[] {
  return session.messages.map((message) => message.content);
}

function user(text: string): OpenAI.ChatCompletionMessageParam {
  return {role: 'user', content: text};
}

function assistant(text: string): OpenAI.ChatCompletionMessageParam {
  return {role: 'assistant', content: text};
}

test('a rewind cuts the messages the model sees', () => {
  const session = conversation();
  recordUsage(session, {prompt: 40, completion: 10, total: 50});

  restoreMessages(session, session.messages.slice(1, 5));

  assert.equal(session.messages.length, 5);
  assert.equal(
    JSON.stringify(session.messages).includes('handle an empty cart'),
    false,
  );
  assert.equal(session.lastContextTokens, 0);
});

test('a rewind keeps everything before the cut', () => {
  const session = conversation();

  restoreMessages(session, session.messages.slice(1, 5));

  assert.deepEqual(texts(session), [
    'rules',
    'fix the cart',
    'fixed',
    'update the readme',
    'updated',
  ]);
});

test('a rewind does not forget approvals', () => {
  const session = conversation();
  session.allowed.add('command:npm test');

  restoreMessages(session, session.messages.slice(1, 3));

  assert.deepEqual([...session.allowed], ['command:npm test']);
});

test('rewinding to the first message leaves only the system message', () => {
  const session = conversation();

  restoreMessages(session, []);

  assert.deepEqual(texts(session), ['rules']);
});

test('a second rewind cuts again', () => {
  const session = conversation();

  restoreMessages(session, session.messages.slice(1, 5));
  restoreMessages(session, session.messages.slice(1, 3));

  assert.deepEqual(texts(session), ['rules', 'fix the cart', 'fixed']);
});

test('a rewind survives quitting and reopening', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-work-'));
  const store = startSession(work, root);
  const one = user('fix the cart');
  store.appendMessage(one);
  store.appendTurn([one, assistant('fixed')], {prompt: 10, completion: 0, total: 10});
  const two = user('and the readme');
  store.appendMessage(two);
  store.appendTurn([two, assistant('updated')], {prompt: 20, completion: 0, total: 20});

  store.rewind(2);
  store.close();

  const reopened = openSession(work, null, root);
  assert.deepEqual(reopened.stored.messages, [user('fix the cart'), assistant('fixed')]);
  reopened.store.close();
});

function onDisk() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-work-'));
  return {session: createSession(work, 'rules', 1_000), store: startSession(work, home)};
}

function turn(
  session: Session,
  store: ReturnType<typeof onDisk>['store'],
  task: string,
  reply: string,
  total: number,
): void {
  const asked = addTask(session, task);
  store.appendMessage(asked);
  const answered = assistant(reply);
  session.messages.push(answered);
  store.appendTurn([asked, answered], {prompt: total, completion: 0, total});
}

function markerAt(store: ReturnType<typeof onDisk>['store']): unknown {
  const lines = fs
    .readFileSync(path.join(store.dir, 'session.jsonl'), 'utf8')
    .trim()
    .split('\n');
  return JSON.parse(lines[lines.length - 1]!);
}

test('a rewind puts the old bytes back', () => {
  const {session, store} = onDisk();
  const note = path.join(session.root, 'note.txt');
  fs.writeFileSync(note, 'one\n');
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendCode('note.txt', captureBefore(store.dir, note));
  fs.writeFileSync(note, 'two\n');

  const outcome = rewindSession(store, session, 0);

  assert.deepEqual(outcome.counts, {restored: 1, deleted: 0, skipped: 0});
  assert.equal(fs.readFileSync(note, 'utf8'), 'one\n');
});

test('a rewind takes away a file the agent created', () => {
  const {session, store} = onDisk();
  const made = path.join(session.root, 'new.txt');
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendCode('new.txt', captureBefore(store.dir, made));
  fs.writeFileSync(made, 'made up\n');

  const outcome = rewindSession(store, session, 0);

  assert.deepEqual(outcome.counts, {restored: 0, deleted: 1, skipped: 0});
  assert.equal(fs.existsSync(made), false);
});

test('a rewind whose copy went missing skips the file and still rewinds', () => {
  const {session, store} = onDisk();
  const note = path.join(session.root, 'note.txt');
  fs.writeFileSync(note, 'one\n');
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendCode('note.txt', captureBefore(store.dir, note));
  fs.writeFileSync(note, 'two\n');
  fs.rmSync(filesDir(store.dir), {recursive: true, force: true});

  const outcome = rewindSession(store, session, 0);

  assert.deepEqual(outcome.counts, {restored: 0, deleted: 0, skipped: 1});
  assert.equal(fs.readFileSync(note, 'utf8'), 'two\n');
  assert.deepEqual(store.records(), []);
});

test('the rewind marker is written after the file is put back', () => {
  const {session, store} = onDisk();
  const note = path.join(session.root, 'note.txt');
  fs.writeFileSync(note, 'one\n');
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendCode('note.txt', captureBefore(store.dir, note));
  fs.writeFileSync(note, 'two\n');

  rewindSession(store, session, 0);

  assert.equal(fs.readFileSync(note, 'utf8'), 'one\n');
  assert.deepEqual(markerAt(store), {kind: 'rewind', to: 0});
});

test('a rewind brings the conversation and the measurement back', () => {
  const {session, store} = onDisk();
  turn(session, store, 'fix the cart', 'fixed', 50);
  turn(session, store, 'and the readme', 'updated', 100);

  rewindSession(store, session, checkpointsOf(store.records())[1]!.at);

  assert.deepEqual(texts(session), ['rules', 'fix the cart', 'fixed']);
  assert.equal(session.lastContextTokens, 50);
});

test('a rewind to the very first message leaves nothing measured', () => {
  const {session, store} = onDisk();
  turn(session, store, 'fix the cart', 'fixed', 50);
  turn(session, store, 'and the readme', 'updated', 100);

  rewindSession(store, session, checkpointsOf(store.records())[0]!.at);

  assert.deepEqual(texts(session), ['rules']);
  assert.equal(session.lastContextTokens, 0);
});

test('a rewind keeps the view items that survived the cut', () => {
  const {session, store} = onDisk();
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendView([{kind: 'task', text: 'fix the cart'}]);
  store.appendMessage(addTask(session, 'and the readme'));
  store.appendView([{kind: 'task', text: 'and the readme'}]);

  const outcome = rewindSession(store, session, checkpointsOf(store.records())[1]!.at);

  assert.deepEqual(outcome.kept, [{kind: 'task', text: 'fix the cart'}]);
});

test('a rewind past no file change counts nothing and leaves the file alone', () => {
  const {session, store} = onDisk();
  const note = path.join(session.root, 'note.txt');
  fs.writeFileSync(note, 'one\n');
  store.appendMessage(addTask(session, 'fix the cart'));
  store.appendCode('note.txt', captureBefore(store.dir, note));
  fs.writeFileSync(note, 'two\n');
  store.appendMessage(addTask(session, 'and the readme'));

  const outcome = rewindSession(store, session, checkpointsOf(store.records())[1]!.at);

  assert.deepEqual(outcome.counts, {restored: 0, deleted: 0, skipped: 0});
  assert.equal(fs.readFileSync(note, 'utf8'), 'two\n');
});
