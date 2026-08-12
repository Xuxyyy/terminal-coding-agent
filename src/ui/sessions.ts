import stringWidth from 'string-width';
import {listSessions} from '../core/projects.js';
import type {SessionMeta} from '../core/store.js';

export type SessionRow = {id: string; title: string; age: string};

export function ageLabel(iso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function sessionRow(meta: SessionMeta, now: Date = new Date()): SessionRow {
  return {
    id: meta.id,
    title: meta.firstTask ?? meta.id,
    age: ageLabel(meta.updatedAt, now),
  };
}

export function rowLine(row: SessionRow, active: boolean, width: number): string {
  const marker = active ? '❯ ' : '  ';
  const room = Math.max(8, width - stringWidth(marker) - stringWidth(row.age) - 1);
  let title = row.title;
  if (stringWidth(title) > room) {
    while (stringWidth(title) > room - 1) title = title.slice(0, -1);
    title += '…';
  }
  const used = stringWidth(marker) + stringWidth(title) + stringWidth(row.age);
  return `${marker}${title}${' '.repeat(Math.max(1, width - used))}${row.age}`;
}

export function sessionRows(workspaceRoot: string): SessionRow[] {
  try {
    return listSessions(workspaceRoot)
      .filter((meta) => meta.usage.total > 0)
      .map((meta) => sessionRow(meta));
  } catch {
    return [];
  }
}
