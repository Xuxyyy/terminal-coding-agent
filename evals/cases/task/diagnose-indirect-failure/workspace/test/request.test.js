import assert from 'node:assert/strict';
import test from 'node:test';
import {retryPlan} from '../src/request.js';

test('the third retry waits 400 milliseconds', () => {
  assert.deepEqual(retryPlan(new Error('temporarily unavailable'), 3), {
    message: 'temporarily unavailable',
    attempt: 3,
    waitMs: 400,
  });
});
