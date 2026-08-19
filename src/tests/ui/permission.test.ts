import assert from 'node:assert/strict';
import test from 'node:test';
import {MODES, type Mode} from '../../core/permission/mode.js';
import {
  CURRENT_MARK,
  NOT_REMEMBERED,
  PERMISSION_LABELS,
  permissionAt,
  permissionLine,
  permissionNotice,
  permissionRows,
} from '../../ui/permission.js';

test('the rows list every mode, with the current one marked', () => {
  const rows = permissionRows('ask-edits');

  assert.deepEqual(
    rows.map((row) => row.id),
    MODES,
  );
  assert.deepEqual(
    rows.filter((row) => row.current).map((row) => row.id),
    ['ask-edits'],
  );
  for (const row of rows) assert.equal(row.label, PERMISSION_LABELS[row.id]);
});

test('the picker opens on the mode the session is in', () => {
  for (const mode of MODES) {
    assert.equal(permissionRows(mode)[permissionAt(mode)]!.id, mode, mode);
  }
});

test('a row reads as the mode and its sentence', () => {
  const [reading] = permissionRows('read-only');

  const active = permissionLine(reading!, true, 80);
  assert.ok(active.startsWith('❯ read-only'), active);
  assert.ok(active.includes(CURRENT_MARK), active);
  assert.ok(active.includes(PERMISSION_LABELS['read-only']), active);

  const idle = permissionLine(permissionRows('auto-edits')[0]!, false, 80);
  assert.ok(idle.startsWith('  read-only'), idle);
  assert.equal(idle.includes(CURRENT_MARK), false);
});

test('a row is cut to the width it is given', () => {
  for (const mode of MODES) {
    const line = permissionLine(permissionRows(mode)[1]!, true, 30);
    assert.ok(line.length <= 30, line);
    assert.ok(line.endsWith('…'), line);
  }
});

test('the notice names the mode that was picked', () => {
  for (const mode of MODES as Mode[]) {
    const notice = permissionNotice(mode);
    assert.ok(notice.includes(mode), notice);
    assert.ok(notice.includes(PERMISSION_LABELS[mode]), notice);
    assert.equal(notice.includes(NOT_REMEMBERED), false, notice);
  }
});

test('the notice says so when the pick could not be saved', () => {
  const notice = permissionNotice('read-only', false);

  assert.ok(notice.includes('read-only'), notice);
  assert.ok(notice.endsWith(NOT_REMEMBERED), notice);
});
