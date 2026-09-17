import assert from 'node:assert/strict';
import test from 'node:test';
import {tokenPreview} from '../src/token-preview.js';

test('keeps four characters on both sides of a long token', () => {
  assert.equal(tokenPreview('abcdefghijkl'), 'abcd...ijkl');
});

test('leaves short values alone', () => {
  assert.equal(tokenPreview('abc123'), 'abc123');
});
