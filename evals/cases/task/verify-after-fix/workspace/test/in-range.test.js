import assert from 'node:assert/strict';
import test from 'node:test';
import {inRange} from '../src/in-range.js';

test('the lower boundary is inside an inclusive range', () => {
  assert.equal(inRange(3, 3, 8), true);
});

test('a middle value is inside the range', () => {
  assert.equal(inRange(5, 3, 8), true);
});
