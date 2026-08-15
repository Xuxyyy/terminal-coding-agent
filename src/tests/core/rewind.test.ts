import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
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
