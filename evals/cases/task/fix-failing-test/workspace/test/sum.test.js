import assert from 'node:assert/strict';
import test from 'node:test';
import {sum} from '../src/sum.js';

test('sum adds every number in the list', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([5]), 5);
  assert.equal(sum([]), 0);
});
