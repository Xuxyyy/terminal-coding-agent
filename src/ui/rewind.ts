import stringWidth from 'string-width';
import type {RestoreCounts} from '../core/history.js';
import {checkpointsOf, type SessionRecord} from '../core/records.js';
import type {RewindFile} from './events.js';
import {textOf} from './restore.js';

export type RewindRow = {
  id: string;
  title: string;
  at: number;
  beforeSummary: boolean;
};

export const NOTHING_TO_REWIND = 'Nothing to rewind yet.';

export const BEFORE_SUMMARY = ' — before the summary';

function lastSummaryAt(records: SessionRecord[]): number {
  let last = -1;
  records.forEach((record, at) => {
    if (record.kind === 'compact') last = at;
  });
  return last;
}

export function rewindRows(records: SessionRecord[]): RewindRow[] {
  const summary = lastSummaryAt(records);
  return checkpointsOf(records).flatMap(({id, at}) => {
    const record = records[at];
    if (record?.kind !== 'message' || record.message.role !== 'user') return [];
    const title = textOf(record.message.content).replace(/\s+/g, ' ').trim();
    return [
      {id, at, title: title || '(empty message)', beforeSummary: at < summary},
    ];
  });
}

export function rewindFiles(plan: Map<string, string | null>): RewindFile[] {
  return [...plan]
    .sort(([one], [two]) => one.localeCompare(two))
    .map(([target, before]) => ({path: target, deleted: before === null}));
}

function files(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

export function rewoundNotice(title: string, counts: RestoreCounts): string {
  const parts = [`rewound to before "${title}"`];
  const done: string[] = [];
  if (counts.restored) done.push(`${files(counts.restored)} restored`);
  if (counts.deleted) {
    done.push(done.length ? `${counts.deleted} deleted` : `${files(counts.deleted)} deleted`);
  }
  if (done.length) parts.push(done.join(', '));
  if (counts.skipped) parts.push(`${files(counts.skipped)} had no saved copy`);
  return parts.join(' · ');
}

export function rewindLine(row: RewindRow, active: boolean, width: number): string {
  const marker = active ? '❯ ' : '  ';
  const suffix = row.beforeSummary ? BEFORE_SUMMARY : '';
  const room = Math.max(8, width - stringWidth(marker) - stringWidth(suffix));
  let title = row.title;
  if (stringWidth(title) > room) {
    while (stringWidth(title) > room - 1) title = title.slice(0, -1);
    title += '…';
  }
  return `${marker}${title}${suffix}`;
}
