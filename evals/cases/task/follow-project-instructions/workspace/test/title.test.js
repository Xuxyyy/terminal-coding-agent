import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeTitle} from '../src/title.js';

test('normalizes title words with the repository separator', () => {
  assert.equal(normalizeTitle('  Release   Notes  '), 'release_notes');
});

test('preserves non-space punctuation', () => {
  assert.equal(normalizeTitle('API: Ready'), 'api:_ready');
});
