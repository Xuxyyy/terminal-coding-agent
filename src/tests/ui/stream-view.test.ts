import assert from 'node:assert/strict';
import test from 'node:test';
import {planPanelRows, streamRowBudget, tailLines} from '../../ui/stream-view.js';

test('streamRowBudget leaves room for the status lines below the stream', () => {
  assert.equal(streamRowBudget(40), 32);
});

test('streamRowBudget also reserves the rows a visible plan panel needs', () => {
  assert.equal(streamRowBudget(40, planPanelRows(5)), 24);
});

test('planPanelRows counts nothing when the plan is empty', () => {
  assert.equal(planPanelRows(0), 0);
});

test('streamRowBudget keeps a usable minimum on a very short terminal', () => {
  assert.equal(streamRowBudget(6), 4);
});

test('streamRowBudget falls back to a safe height without terminal rows', () => {
  assert.equal(streamRowBudget(undefined), 16);
});

test('tailLines keeps short text untouched', () => {
  assert.equal(tailLines('one\ntwo', 10, 80), 'one\ntwo');
});

test('tailLines drops the oldest lines once the budget is spent', () => {
  const text = ['a', 'b', 'c', 'd', 'e'].join('\n');
  assert.equal(tailLines(text, 3, 80), 'c\nd\ne');
});

test('tailLines counts a wrapped line as the rows it really occupies', () => {
  const text = ['old', 'x'.repeat(25), 'last'].join('\n');
  assert.equal(tailLines(text, 4, 10), `${'x'.repeat(25)}\nlast`);
});

test('tailLines measures wide characters as two columns', () => {
  const text = ['old', '中'.repeat(6), 'last'].join('\n');
  assert.equal(tailLines(text, 3, 8), `${'中'.repeat(6)}\nlast`);
});

test('tailLines trims a single line that alone overflows the budget', () => {
  assert.equal(tailLines('x'.repeat(30), 2, 10), 'x'.repeat(20));
});

test('tailLines returns nothing for empty text', () => {
  assert.equal(tailLines('', 5, 80), '');
});
