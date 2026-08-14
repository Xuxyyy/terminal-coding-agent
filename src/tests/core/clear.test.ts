import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {
  CLEARED_CONTENT,
  CLEARED_OUTPUT,
  CLEARED_READ,
  clearRecoverable,
} from '../../core/clear.js';
import {createSession, type Session} from '../../core/session.js';

type Message = OpenAI.ChatCompletionMessageParam;

function callTurn(id: string, name: string, args = '{}'): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{id, type: 'function', function: {name, arguments: args}}],
  };
}

function result(id: string, content: string): Message {
  return {role: 'tool', tool_call_id: id, content};
}

function sessionOf(...messages: Message[]): Session {
  const active = createSession(process.cwd(), 'rules', 1_000_000);
  active.messages.push({role: 'user', content: 'rename the widget'}, ...messages);
  return active;
}

function lastRound(): Message[] {
  return [callTurn('last', 'bash', '{"command":"ls"}'), result('last', '[exit 0]\nok')];
}

function contentOf(session: Session, index: number): string {
  const content = session.messages[index]?.content;
  assert.equal(typeof content, 'string');
  return content as string;
}

function argsOf(session: Session, index: number): {path?: string; content?: string} {
  const message = session.messages[index] as {
    tool_calls?: {function: {arguments: string}}[];
  };
  const raw = message.tool_calls?.[0]?.function.arguments ?? '{}';
  return JSON.parse(raw) as {path?: string; content?: string};
}

test('a read_file result is cleared and the freed tokens are reported', () => {
  const session = sessionOf(
    callTurn('r1', 'read_file', '{"path":"a.ts"}'),
    result('r1', 'a'.repeat(40_000)),
    ...lastRound(),
  );

  const freed = clearRecoverable(session, 0, []);

  assert.ok(freed > 9_000, `freed ${freed}`);
  assert.equal(contentOf(session, 3), CLEARED_READ);
});

test('edit_file and write_file results are left alone', () => {
  const session = sessionOf(
    callTurn('e1', 'edit_file', '{"path":"a.ts"}'),
    result('e1', "Edited 'a.ts'."),
    callTurn('w1', 'write_file', '{"path":"b.ts","content":"hi"}'),
    result('w1', "Wrote 2 chars to 'b.ts'."),
    ...lastRound(),
  );

  clearRecoverable(session, 0, []);

  assert.equal(contentOf(session, 3), "Edited 'a.ts'.");
  assert.equal(contentOf(session, 5), "Wrote 2 chars to 'b.ts'.");
});

test('a bash result keeps its exit line and loses its body', () => {
  const session = sessionOf(
    callTurn('b1', 'bash', '{"command":"ls"}'),
    result('b1', `[exit 0]\n${'x'.repeat(20_000)}`),
    ...lastRound(),
  );

  const freed = clearRecoverable(session, 0, []);

  assert.ok(freed > 4_000, `freed ${freed}`);
  assert.equal(contentOf(session, 3), `[exit 0]\n${CLEARED_OUTPUT}`);
});

test('write_file arguments lose the body and keep the path', () => {
  const session = sessionOf(
    callTurn('w1', 'write_file', JSON.stringify({path: 'b.ts', content: 'z'.repeat(40_000)})),
    result('w1', "Wrote 40000 chars to 'b.ts'."),
    ...lastRound(),
  );

  const freed = clearRecoverable(session, 0, []);

  assert.ok(freed > 9_000, `freed ${freed}`);
  assert.deepEqual(argsOf(session, 2), {path: 'b.ts', content: CLEARED_CONTENT});
});

test('the last round is never cleared', () => {
  const session = sessionOf(
    callTurn('r1', 'read_file', '{"path":"a.ts"}'),
    result('r1', 'a'.repeat(40_000)),
  );

  const freed = clearRecoverable(session, 0, []);

  assert.equal(freed, 0);
  assert.equal(contentOf(session, 3), 'a'.repeat(40_000));
});

test('a second pass over a cleared session frees nothing', () => {
  const session = sessionOf(
    callTurn('r1', 'read_file', '{"path":"a.ts"}'),
    result('r1', 'a'.repeat(40_000)),
    callTurn('b1', 'bash', '{"command":"ls"}'),
    result('b1', `[exit 0]\n${'x'.repeat(20_000)}`),
    ...lastRound(),
  );

  assert.ok(clearRecoverable(session, 0, []) > 0);
  assert.equal(clearRecoverable(session, 0, []), 0);
});

test('clearing stops as soon as the projection is under target', () => {
  const session = sessionOf(
    callTurn('r1', 'read_file', '{"path":"a.ts"}'),
    result('r1', 'a'.repeat(40_000)),
    callTurn('r2', 'read_file', '{"path":"b.ts"}'),
    result('r2', 'b'.repeat(40_000)),
    ...lastRound(),
  );

  clearRecoverable(session, 15_000, []);

  assert.equal(contentOf(session, 3), CLEARED_READ);
  assert.equal(contentOf(session, 5), 'b'.repeat(40_000));
});
