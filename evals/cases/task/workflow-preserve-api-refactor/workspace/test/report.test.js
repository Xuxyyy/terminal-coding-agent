import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReport, formatRecord} from '../src/index.js';

test('normalizes whitespace, tag values, and numeric scores', () => {
  const record = {
    name: '  Cara  ',
    score: '5',
    active: true,
    tags: [' release ', '', 'owner'],
  };

  assert.equal(formatRecord(record), 'Cara: 5 (active) | release, owner');
  assert.deepEqual(buildReport([record]), {
    count: 1,
    activeCount: 1,
    scoreTotal: 5,
    records: [
      {name: 'Cara', score: 5, active: true, tags: ['release', 'owner']},
    ],
  });
});

test('rejects a non-array report input', () => {
  assert.throws(
    () => buildReport({name: 'Ada'}),
    new TypeError('records must be an array'),
  );
});
