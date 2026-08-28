import assert from 'node:assert/strict';
import test from 'node:test';
import {clamp} from '../src/clamp.js';

test('clamp holds a value between two bounds', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});
