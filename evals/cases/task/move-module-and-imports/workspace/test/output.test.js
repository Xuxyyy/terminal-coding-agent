import assert from 'node:assert/strict';
import test from 'node:test';
import {report} from '../src/report.js';
import {summary} from '../src/summary.js';

test('report keeps its formatted output', () => {
  assert.equal(report(' ready ', 3), 'READY: 3');
});

test('summary formats every label', () => {
  assert.equal(summary([' one', 'two ']), 'ONE, TWO');
});
