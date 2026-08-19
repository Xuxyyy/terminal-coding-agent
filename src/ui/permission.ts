import stringWidth from 'string-width';
import {MODES, type Mode} from '../core/permission/mode.js';

export type PermissionRow = {id: Mode; label: string; current: boolean};

export const PERMISSION_LABELS: Record<Mode, string> = {
  'read-only': 'read-only; nothing will be written',
  'ask-edits': 'asks before every edit, and before anything git cannot undo',
  'auto-edits': 'asks before anything git cannot undo',
};

export const PERMISSION_TITLE = 'Choose what runs without asking';

export const PERMISSION_HINT = '↑↓ to move · enter to choose · esc to cancel';

export const CURRENT_MARK = ' (current)';

export function permissionRows(current: Mode): PermissionRow[] {
  return MODES.map((mode) => ({
    id: mode,
    label: PERMISSION_LABELS[mode],
    current: mode === current,
  }));
}

export function permissionAt(current: Mode): number {
  return MODES.indexOf(current);
}

export function permissionLine(
  row: PermissionRow,
  active: boolean,
  width: number,
): string {
  const marker = active ? '❯ ' : '  ';
  const name = `${row.id}${row.current ? CURRENT_MARK : ''}`;
  let line = `${marker}${name} — ${row.label}`;
  if (stringWidth(line) <= width) return line;
  while (stringWidth(line) > width - 1) line = line.slice(0, -1);
  return `${line}…`;
}

export const NOT_REMEMBERED = ' (this session only: the settings file could not be written)';

export function permissionNotice(mode: Mode, remembered = true): string {
  const notice = `permission mode: ${mode} — ${PERMISSION_LABELS[mode]}`;
  return remembered ? notice : `${notice}${NOT_REMEMBERED}`;
}
