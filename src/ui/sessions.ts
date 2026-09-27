import * as path from 'node:path';
import stringWidth from 'string-width';
import {listSessions, sessionsDir} from '../core/projects.js';
import {sessionIsLocked} from '../core/session-lock.js';
import type {SessionMeta} from '../core/store.js';

export type SessionRow = {id: string; title: string; age: string; locked: boolean};

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

export function sessionRow(
  meta: SessionMeta,
  now: Date = new Date(),
  locked = false,
): SessionRow {
  return {
    id: meta.id,
    title: meta.firstTask ?? meta.id,
    age: ageLabel(meta.updatedAt, now),
    locked,
  };
}

export function rowLine(row: SessionRow, active: boolean, width: number): string {
  const marker = active ? '❯ ' : '  ';
  const tail = row.locked ? `active elsewhere · ${row.age}` : row.age;
  const room = Math.max(8, width - stringWidth(marker) - stringWidth(tail) - 1);
  let title = row.title;
  if (stringWidth(title) > room) {
    while (stringWidth(title) > room - 1) title = title.slice(0, -1);
    title += '…';
  }
  const used = stringWidth(marker) + stringWidth(title) + stringWidth(tail);
  return `${marker}${title}${' '.repeat(Math.max(1, width - used))}${tail}`;
}

export function sessionRows(workspaceRoot: string): SessionRow[] {
  try {
    const root = sessionsDir(workspaceRoot);
    return listSessions(workspaceRoot)
      .filter((meta) => meta.usage.total > 0 || meta.firstTask !== undefined)
      .map((meta) =>
        sessionRow(meta, new Date(), sessionIsLocked(path.join(root, meta.id))),
      );
  } catch {
    return [];
  }
}
