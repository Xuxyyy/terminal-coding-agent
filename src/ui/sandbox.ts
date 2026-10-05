import type {SandboxMode} from '../core/sandbox/mode.js';
import type {RowParts} from './events.js';
import {fit} from './permission.js';

export type SandboxRow = {id: SandboxMode; label: string; current: boolean};

export function sandboxLabel(mode: SandboxMode): string {
  return mode === 'on' ? 'On' : 'Off';
}

export function sandboxRows(current: SandboxMode): SandboxRow[] {
  return (['off', 'on'] as const).map((id) => ({
    id,
    label: id === 'on' ? 'OS isolation; fails closed if unavailable' : 'No OS file or network isolation',
    current: id === current,
  }));
}

export function sandboxLine(row: SandboxRow, active: boolean, width: number): RowParts {
  const text = `${active ? '❯ ' : '  '}${sandboxLabel(row.id)}${row.current ? ' (current)' : ''} — ${row.label}`;
  return {head: fit(text, width), tail: ''};
}
