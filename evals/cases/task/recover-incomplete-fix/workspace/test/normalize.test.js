import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeSlug as normalizeProject} from '../src/projects/normalize.js';
import {normalizeSlug as normalizeUser} from '../src/users/normalize.js';

test('project slugs normalize a simple label', () => {
  assert.equal(normalizeProject('  Road Map  '), 'road-map');
});

test('user slugs normalize a simple label', () => {
  assert.equal(normalizeUser('  Ada Lovelace  '), 'ada-lovelace');
});
