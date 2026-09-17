import assert from 'node:assert/strict';
import test from 'node:test';
import {identifier} from '../src/identifier.js';

test('identifier collapses separators', () => {
  assert.equal(identifier('  Alpha / Beta  '), 'alpha-beta');
  assert.equal(identifier('one---two'), 'one-two');
});

test('identifier keeps letters and digits', () => {
  assert.equal(identifier('Release 22'), 'release-22');
});
