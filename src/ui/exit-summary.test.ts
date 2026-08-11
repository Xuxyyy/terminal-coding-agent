import assert from 'node:assert/strict';
import test from 'node:test';
import {dimText, formatExitSummary} from './exit-summary.js';

test('formatExitSummary describes the closed session', () => {
  assert.equal(formatExitSummary(), 'Session ended');
});

test('dimText resets the terminal intensity after the summary', () => {
  assert.equal(dimText('Session ended'), '\u001B[2mSession ended\u001B[22m');
});
