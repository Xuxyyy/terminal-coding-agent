import assert from 'node:assert/strict';
import test from 'node:test';
import {replaceCaseTrials} from './compose-task.js';

test('replacement trials take the matching base positions without reordering cases', () => {
  const base = [
    {id: 'a', value: 'a1'},
    {id: 'b', value: 'b1'},
    {id: 'a', value: 'a2'},
    {id: 'b', value: 'b2'},
  ];
  const replacement = [
    {id: 'b', value: 'new-b1'},
    {id: 'b', value: 'new-b2'},
  ];

  assert.deepEqual(replaceCaseTrials(base, replacement, 2), {
    records: [
      {id: 'a', value: 'a1'},
      {id: 'b', value: 'new-b1'},
      {id: 'a', value: 'a2'},
      {id: 'b', value: 'new-b2'},
    ],
    replacedCaseIds: ['b'],
  });
});

test('composition rejects missing cases and incomplete repeats', () => {
  const base = [
    {id: 'a', value: 1},
    {id: 'a', value: 2},
  ];

  assert.throws(
    () => replaceCaseTrials([{id: 'a', value: 1}], [{id: 'missing', value: 1}], 1),
    /absent from base/,
  );
  assert.throws(
    () => replaceCaseTrials(base, [{id: 'a', value: 1}], 2),
    /has 1 trials, expected 2/,
  );
});
