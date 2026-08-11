import assert from 'node:assert/strict';
import test from 'node:test';
import {DIFF_MAX_LINES, diffPayload} from './diff.js';

test('diffPayload counts the change and keeps surrounding context', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nC\nd\ne\n';

  const diff = diffPayload('f.ts', before, after);

  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hidden, 0);
  assert.deepEqual(
    diff.rows.map((row) => row.kind),
    ['context', 'context', 'remove', 'add', 'context', 'context'],
  );
  assert.deepEqual(
    diff.rows.filter((row) => row.kind === 'remove'),
    [{kind: 'remove', line: 3, text: 'c'}],
  );
});

test('diffPayload marks a gap between two distant changes', () => {
  const lines = Array.from({length: 20}, (_, i) => `line ${i}`);
  const after = [...lines];
  after[1] = 'changed one';
  after[18] = 'changed two';

  const diff = diffPayload('f.ts', lines.join('\n'), after.join('\n'));

  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.equal(diff.rows.filter((row) => row.kind === 'gap').length, 1);
});

test('diffPayload hides rows past the display limit', () => {
  const before = Array.from({length: 40}, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({length: 40}, (_, i) => `changed ${i}`).join('\n');

  const diff = diffPayload('f.ts', before, after);

  assert.equal(diff.added, 40);
  assert.equal(diff.removed, 40);
  assert.equal(diff.rows.length, DIFF_MAX_LINES);
  assert.equal(diff.hidden, 80 - DIFF_MAX_LINES);
});

test('diffPayload treats a new file as all additions', () => {
  const diff = diffPayload('f.ts', '', 'a\nb\n');

  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
});
