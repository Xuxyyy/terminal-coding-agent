import stringWidth from 'string-width';
import {checkpointsOf, type SessionRecord} from '../core/records.js';
import {textOf} from './restore.js';

export type RewindRow = {id: string; title: string; at: number};

export const NOTHING_TO_REWIND = 'Nothing to rewind yet.';

export function rewindRows(records: SessionRecord[]): RewindRow[] {
  return checkpointsOf(records).flatMap(({id, at}) => {
    const record = records[at];
    if (record?.kind !== 'message' || record.message.role !== 'user') return [];
    const title = textOf(record.message.content).replace(/\s+/g, ' ').trim();
    return [{id, at, title: title || '(empty message)'}];
  });
}

export function rewindLine(row: RewindRow, active: boolean, width: number): string {
  const marker = active ? '❯ ' : '  ';
  const room = Math.max(8, width - stringWidth(marker));
  let title = row.title;
  if (stringWidth(title) > room) {
    while (stringWidth(title) > room - 1) title = title.slice(0, -1);
    title += '…';
  }
  return `${marker}${title}`;
}
