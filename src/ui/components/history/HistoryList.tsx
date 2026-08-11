import {useMemo} from 'react';
import {Box, Static} from 'ink';
import type {DiffPayload, Item} from '../../events.js';
import {Entry} from '../Entry.js';
import {ToolEntry} from './ToolEntry.js';

type StandardRow = {
  kind: 'standard';
  id: string;
  item: Item;
};

type ToolRow = {
  kind: 'tool';
  id: string;
  name: string;
  args: unknown;
  result: string | null;
  diff: DiffPayload | null;
};

export type HistoryRow = StandardRow | ToolRow;

function eventParts(item: Item): unknown[] | null {
  if (item.kind !== 'event' || !Array.isArray(item.event.detail)) return null;
  return item.event.detail;
}

export function historyRows(items: Item[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let pendingTool: ToolRow | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const parts = eventParts(item);
    if (item.kind === 'event' && item.event.type === 'tool' && parts !== null) {
      pendingTool = {
        kind: 'tool',
        id: `tool:${index}`,
        name: String(parts[0]),
        args: parts[1],
        result: null,
        diff: null,
      };
      rows.push(pendingTool);
      continue;
    }
    if (
      item.kind === 'event' &&
      item.event.type === 'result' &&
      parts !== null &&
      pendingTool !== null &&
      parts[0] === pendingTool.name
    ) {
      pendingTool.result = String(parts[1]);
      pendingTool.diff = parts[2] as DiffPayload | null;
      pendingTool = null;
      continue;
    }
    rows.push({kind: 'standard', id: `item:${index}`, item});
  }
  return rows;
}

function lastToolIndex(rows: HistoryRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.kind === 'tool') return index;
  }
  return -1;
}

export function splitRows(rows: HistoryRow[]): {
  done: HistoryRow[];
  live: HistoryRow[];
} {
  const runningIndex = lastToolIndex(rows);
  const pendingIndex = rows.findIndex((row, index) =>
    row.kind === 'tool'
      ? index === runningIndex && row.result === null
      : row.item.kind === 'header' && row.item.ready === undefined,
  );
  if (pendingIndex < 0) return {done: rows, live: []};
  return {done: rows.slice(0, pendingIndex), live: rows.slice(pendingIndex)};
}

function workspaceRoot(items: Item[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'header') return item.workspaceRoot;
  }
  return undefined;
}

export function HistoryList({items}: {items: Item[]}) {
  const rows = useMemo(() => historyRows(items), [items]);
  const root = useMemo(() => workspaceRoot(items), [items]);
  const {done, live} = useMemo(() => splitRows(rows), [rows]);

  const render = (row: HistoryRow) =>
    row.kind === 'tool' ? (
      <ToolEntry
        key={row.id}
        name={row.name}
        args={row.args}
        result={row.result}
        diff={row.diff}
        workspaceRoot={root}
      />
    ) : (
      <Entry key={row.id} item={row.item} />
    );

  return (
    <Box flexDirection="column">
      <Static items={done}>{(row) => render(row)}</Static>
      {live.map((row) => render(row))}
    </Box>
  );
}
