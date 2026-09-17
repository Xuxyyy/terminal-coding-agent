import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeTags} from '../src/tag-summary.js';

test('summarizes the first request', () => {
  assert.equal(summarizeTags([' Red ']), 'red');
});

test('a later request starts with no tags', () => {
  assert.equal(summarizeTags(['Blue']), 'blue');
});
