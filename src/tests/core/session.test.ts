import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTask,
  clearSession,
  contextStatus,
  createSession,
  recordUsage,
} from '../../core/session.js';

test('clearing the session forgets approvals', () => {
  const session = createSession('/tmp/work', 'rules', 1_000);
  session.allowed.add('command:npm test');
  addTask(session, 'do the thing');
  recordUsage(session, {prompt: 10, completion: 5, total: 15});

  clearSession(session);

  assert.equal(session.allowed.size, 0);
  assert.deepEqual(session.messages, [{role: 'system', content: 'rules'}]);
  assert.equal(session.lastContextTokens, 0);
});

test('a session with no turn yet reports an estimated total', () => {
  const session = createSession('/tmp/work', 'rules', 200_000);

  const status = contextStatus(session);

  assert.equal(status.measured, false);
  assert.ok(status.used > 0, `expected a non-zero estimate, got ${status.used}`);
});

test('a recorded turn becomes the measured total', () => {
  const session = createSession('/tmp/work', 'rules', 200_000);
  addTask(session, 'do the thing');
  recordUsage(session, {prompt: 12_000, completion: 450, total: 12_450});

  const status = contextStatus(session);

  assert.equal(status.measured, true);
  assert.equal(status.used, 12_450);
});

test('the context breakdown adds up before and after a turn', () => {
  const session = createSession('/tmp/work', 'rules', 200_000);
  addTask(session, 'do the thing');
  const before = contextStatus(session);
  recordUsage(session, {prompt: 12_000, completion: 450, total: 12_450});
  const after = contextStatus(session);

  for (const [when, status] of [
    ['before the turn', before],
    ['after the turn', after],
  ] as const) {
    assert.equal(
      status.system + status.tools + status.conversation,
      status.used,
      when,
    );
    assert.equal(status.used + status.free, status.budget, when);
  }
});
