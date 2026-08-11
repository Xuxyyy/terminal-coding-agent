import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmChoices, confirmDecisionForKey} from './confirm.js';

const line = (suppressible: boolean) =>
  confirmChoices(suppressible)
    .map((choice) => `${choice.key} ${choice.label}`)
    .join(' · ');

test('a suppressible command offers all three answers', () => {
  assert.equal(
    line(true),
    'y approve once · a allow for this session · n deny',
  );
  assert.equal(confirmDecisionForKey('y', true), 'once');
  assert.equal(confirmDecisionForKey('a', true), 'session');
  assert.equal(confirmDecisionForKey('n', true), 'deny');
});

test('a command that will ask again hides the session answer', () => {
  assert.equal(line(false), 'y approve once · n deny');
  assert.equal(confirmDecisionForKey('a', false), undefined);
  assert.equal(confirmDecisionForKey('y', false), 'once');
  assert.equal(confirmDecisionForKey('n', false), 'deny');
});

test('uppercase keys answer the same as lowercase', () => {
  assert.equal(confirmDecisionForKey('Y', true), 'once');
  assert.equal(confirmDecisionForKey('A', true), 'session');
  assert.equal(confirmDecisionForKey('N', true), 'deny');
  assert.equal(confirmDecisionForKey('A', false), undefined);
});

test('an unrelated key answers nothing', () => {
  assert.equal(confirmDecisionForKey('q', true), undefined);
  assert.equal(confirmDecisionForKey('', true), undefined);
});
