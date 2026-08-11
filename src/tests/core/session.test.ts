import assert from 'node:assert/strict';
import test from 'node:test';
import {addTask, clearSession, createSession, recordUsage} from '../../core/session.js';

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
