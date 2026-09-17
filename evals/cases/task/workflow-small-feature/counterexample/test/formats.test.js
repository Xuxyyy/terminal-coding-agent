import assert from 'node:assert/strict';
import test from 'node:test';
import {getFormat, listFormats} from '../src/index.js';

test('lists the configured report formats', () => {
  assert.deepEqual(
    listFormats().map((format) => format.id),
    ['text', 'json', 'csv'],
  );
});

test('returns metadata for a configured format', () => {
  assert.deepEqual(getFormat('json'), {
    id: 'json',
    extension: 'json',
    contentType: 'application/json',
  });
});

test('returns metadata for CSV', () => {
  assert.deepEqual(getFormat('csv'), {
    id: 'csv',
    extension: 'csv',
    contentType: 'text/csv',
  });
});

test('returns null for an unknown format', () => {
  assert.equal(getFormat('yaml'), null);
});
