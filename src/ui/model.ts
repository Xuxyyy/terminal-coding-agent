import stringWidth from 'string-width';
import {hasKey, keyEnvOf, MODELS, MODEL_IDS} from '../core/models.js';
import type {RowParts} from './events.js';
import {CURRENT_MARK, fit, NOT_REMEMBERED} from './permission.js';

export type ModelRow = {
  id: string;
  label: string;
  current: boolean;
  missingKey: string | null;
};

export const MODEL_TITLE = 'Choose a model';

export const MODEL_HINT = '↑↓ to move · enter to choose · esc to cancel';

export function modelRows(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelRow[] {
  return MODEL_IDS.map((id) => ({
    id,
    label: MODELS[id]!.label,
    current: id === current,
    missingKey: hasKey(id, env) ? null : keyEnvOf(id),
  }));
}

export function modelAt(current: string): number {
  const index = MODEL_IDS.indexOf(current);
  return index === -1 ? 0 : index;
}

export function modelLine(
  row: ModelRow,
  active: boolean,
  width: number,
): RowParts {
  const marker = active ? '❯ ' : '  ';
  const head = `${marker}${row.label}${row.current ? CURRENT_MARK : ''}`;
  const tail = row.missingKey ? ` — needs ${row.missingKey}` : ` — ${row.id}`;
  const room = width - stringWidth(head);
  if (room >= stringWidth(tail)) return {head, tail};
  if (room <= 2) return {head: fit(head, width), tail: ''};
  return {head, tail: fit(tail, room)};
}

export function modelNotice(label: string, remembered = true): string {
  const notice = `switched to ${label}`;
  return remembered ? notice : `${notice}${NOT_REMEMBERED}`;
}

export function missingKeyHint(row: ModelRow): string {
  return `set ${row.missingKey} to use this model`;
}
