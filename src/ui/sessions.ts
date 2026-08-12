import {listSessions, type SessionMeta} from '../core/store.js';

export type SessionRow = {id: string; title: string; detail: string};

export function sessionRow(meta: SessionMeta): SessionRow {
  const when = meta.startedAt.replace('T', ' ').slice(0, 16);
  const tokens = meta.usage.total.toLocaleString('en-US');
  return {
    id: meta.id,
    title: meta.firstTask ?? meta.id,
    detail: `${when} · ${tokens} tokens`,
  };
}

export function sessionRows(workspaceRoot: string): SessionRow[] {
  try {
    return listSessions(workspaceRoot)
      .filter((meta) => meta.usage.total > 0)
      .map(sessionRow);
  } catch {
    return [];
  }
}
