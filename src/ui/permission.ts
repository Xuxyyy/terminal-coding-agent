import stringWidth from 'string-width';
import {MODES, type Mode} from '../core/permission/mode.js';
import type {Item, RowParts} from './events.js';

export type PermissionRow = {id: Mode; label: string; current: boolean};

export const PERMISSION_LABELS: Record<Mode, string> = {
  'read-only': 'nothing is written',
  'ask-edits': 'asks before every edit',
  'auto-edits': 'edits without asking',
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

function fit(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let cut = text;
  while (stringWidth(cut) > width - 1) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function permissionLine(
  row: PermissionRow,
  active: boolean,
  width: number,
): RowParts {
  const marker = active ? '❯ ' : '  ';
  const head = `${marker}${row.id}${row.current ? CURRENT_MARK : ''}`;
  const tail = ` — ${row.label}`;
  const room = width - stringWidth(head);
  if (room >= stringWidth(tail)) return {head, tail};
  if (room <= 2) return {head: fit(head, width), tail: ''};
  return {head, tail: fit(tail, room)};
}

export const NOT_REMEMBERED = ' (not saved to settings.json)';

export function permissionNotice(mode: Mode, remembered = true): string {
  const notice = `switched to ${mode}`;
  return remembered ? notice : `${notice}${NOT_REMEMBERED}`;
}

export function withPermission(item: Item, mode: Mode): Item {
  if (item.kind !== 'header' || !item.ready) return item;
  return {
    ...item,
    ready: {...item.ready, permission: {id: mode}},
  };
}
