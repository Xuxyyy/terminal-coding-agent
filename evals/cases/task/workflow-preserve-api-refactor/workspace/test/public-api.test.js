import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReport, formatRecord, renderReport} from '../src/index.js';

test('the public entry point exposes record helpers', () => {
  const records = [
    {name: 'Ada', score: 8, active: true, tags: ['core']},
    {name: 'Bob', score: 2, active: false, tags: []},
  ];

  assert.equal(formatRecord(records[0]), 'Ada: 8 (active) | core');
  assert.equal(formatRecord(records[1]), 'Bob: 2 (inactive)');
  assert.equal(
    renderReport(records),
    '1/2 active, total 10\nAda: 8 (active) | core\nBob: 2 (inactive)',
  );
  assert.deepEqual(buildReport(records), {
    count: 2,
    activeCount: 1,
    scoreTotal: 10,
    records,
  });
});
