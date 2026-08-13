import path from 'node:path';
import type {AgentEvent, DiffPayload} from '../core/host.js';
import type {ContextStatus} from '../core/session.js';

export type {ContextStatus};

export type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
  DiffPayload,
  DiffRow,
  Usage,
} from '../core/host.js';

export type PermissionInfo = {id: string; label: string};

export type ReadyInfo = {
  workspace: string;
  model: {id: string; label: string};
  permission: PermissionInfo;
};

export type HeaderItem = {
  kind: 'header';
  workspaceRoot: string;
  ready?: ReadyInfo;
};
export type TextItem = {kind: 'text'; text: string};
export type TaskItem = {kind: 'task'; text: string};
export type NoticeItem = {kind: 'notice'; text: string};
export type ContextItem = {kind: 'context'} & Partial<ContextStatus> &
  Pick<ContextStatus, 'used' | 'budget'>;
export type EventItem = {kind: 'event'; event: AgentEvent};

export type Item =
  | HeaderItem
  | TextItem
  | TaskItem
  | NoticeItem
  | ContextItem
  | EventItem;

import type {ConfirmRequest} from '../core/host.js';

export type Phase =
  | {kind: 'idle'}
  | {kind: 'busy'; label?: string}
  | {kind: 'confirming'; request: ConfirmRequest}
  | {kind: 'picking'}
  | {kind: 'rewinding'}
  | {kind: 'closed'};

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length > n ? lines.slice(-n).join('\n') : text;
}

const COMMAND_TOOLS = new Set(['bash']);

const ARG_KEY: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  bash: 'command',
};

export function toolDescription(name: string, args: unknown): string {
  if (name !== 'bash' || !args || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>).description;
  if (typeof value !== 'string') return '';
  return truncate(value.replace(/\s+/g, ' ').trim(), 60);
}

export function formatArgs(
  name: string,
  args: unknown,
  workspaceRoot?: string,
): string {
  if (!args || typeof args !== 'object') return '';
  const key = ARG_KEY[name];
  if (!key) return '';
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined || value === null) return '';
  let text = String(value).replace(/\s+/g, ' ').trim();
  if (key === 'path' && workspaceRoot && path.isAbsolute(text)) {
    text = path.relative(workspaceRoot, text) || '.';
  }
  if (COMMAND_TOOLS.has(name)) {
    const match = text.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&\s*/);
    const directory = match?.[1] ?? match?.[2] ?? match?.[3];
    if (
      match &&
      directory &&
      workspaceRoot &&
      directory.replace(/\/+$/, '') === workspaceRoot.replace(/\/+$/, '')
    ) {
      text = text.slice(match[0].length);
    }
    text = text.replace(
      /(^|[\s"'=])\/(?:[^/\s"';&|]+\/)+([^/\s"';&|]+)/g,
      '$1…/$2',
    );
    return truncate(text, 80);
  }
  return truncate(text, 60);
}

export function formatResult(name: string, result: string): string {
  if (COMMAND_TOOLS.has(name)) {
    const match = result.match(/^\[exit (\d+)\]\n?/);
    if (match) {
      const body = result.slice(match[0].length).trimEnd();
      const output = body || '(no output)';
      return match[1] === '0' ? output : `exit ${match[1]}\n${output}`;
    }
    return result.trimEnd();
  }
  return result.trimEnd();
}

export function resultStatus(name: string, result: string): string {
  if (result.startsWith('Error:')) {
    const message = result.slice('Error:'.length).trim().split('\n')[0]?.trim();
    return message ? `failed: ${truncate(message, 50)}` : 'failed';
  }
  if (COMMAND_TOOLS.has(name)) {
    const match = result.match(/^\[exit (\d+)\]/);
    if (!match) return 'done';
    return match[1] === '0' ? 'exit 0' : `exit ${match[1]}`;
  }
  return 'done';
}

export const FAILURE_OUTPUT_LINES = 10;
const TRUNCATION_MARK = '... [truncated]';

export function failureOutput(name: string, result: string): string | null {
  if (!COMMAND_TOOLS.has(name)) return null;
  const match = result.match(/^\[exit (\d+)\]\n?/);
  if (!match || match[1] === '0') return null;
  const body = result.slice(match[0].length).trimEnd();
  if (!body) return null;
  return tailLines(body, FAILURE_OUTPUT_LINES);
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function resultCount(name: string, result: string): string | null {
  if (name !== 'read_file') return null;
  const partial = result.trimEnd().endsWith(TRUNCATION_MARK)
    ? ' (truncated)'
    : '';
  const range = result.match(/\[file has (\d+) lines; showing (\d+)-(\d+)\./);
  if (range) {
    return `lines ${Number(range[2]).toLocaleString('en-US')}-${Number(range[3]).toLocaleString('en-US')}`;
  }
  const note = result.match(/\[file has (\d+) lines/);
  if (note) return count(Number(note[1]), 'line', 'lines');
  const lines = result.replace(/\n+$/, '').split('\n').length;
  return count(lines, 'line', 'lines') + partial;
}

export function writeSummary(name: string, result: string): string | null {
  if (name !== 'write_file') return null;
  const match = result.match(/^Wrote (\d+) chars/);
  if (!match) return null;
  const chars = Number(match[1]).toLocaleString('en-US');
  return `created, ${chars} chars`;
}

export function noticeText(result: string): string | null {
  const match = result.match(/\bNote: (.+)$/s);
  return match ? match[1].trim() : null;
}

export function diffSummary(diff: DiffPayload): string {
  const parts: string[] = [];
  if (diff.added) parts.push(`+${diff.added}`);
  if (diff.removed) parts.push(`−${diff.removed}`);
  return parts.join(' ');
}

const BAR_WIDTH = 20;
const ROW_WIDTH = BAR_WIDTH + 2;

const PART_LABELS: [keyof ContextStatus, string][] = [
  ['system', 'system prompt'],
  ['tools', 'system tools'],
  ['conversation', 'messages'],
  ['free', 'free'],
];

function tokenText(n: number, estimated: boolean): string {
  return `${estimated ? '~' : ''}${n.toLocaleString('en-US')}`;
}

export function contextReadout(status: ContextItem): {
  line: string;
  bar: string;
  parts: string[];
} {
  const {used, budget} = status;
  const measured = status.measured ?? true;
  const pct = budget > 0 ? used / budget : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.floor(pct * BAR_WIDTH)));
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const rounded = Math.round(pct * 100);
  const share = used > 0 && rounded === 0 ? '<1' : String(rounded);
  const line = `context: ${tokenText(used, !measured)} / ${budget.toLocaleString('en-US')} tokens (${share}%)`;

  const present = PART_LABELS.filter(([key]) => typeof status[key] === 'number');
  if (present.length === 0) return {line, bar, parts: []};

  const shown = present.map(([key, label]) => ({
    label,
    text: tokenText(status[key] as number, key === 'free' ? !measured : true),
  }));
  const numbers = Math.max(...shown.map((part) => part.text.length));
  const labels = Math.max(...shown.map((part) => part.label.length));
  const width = Math.max(ROW_WIDTH, labels + 2 + numbers);
  const parts = shown.map(
    (part) => part.label.padEnd(width - numbers) + part.text.padStart(numbers),
  );
  return {line, bar, parts};
}

export const COMPACTING_LABEL = 'Compacting…';

export function thresholdNotice(used: number, budget: number): string {
  const share = budget > 0 ? Math.round((used / budget) * 100) : 0;
  return `↯ context is ${share}% full — compacting…`;
}

export function compactionNotice(replaced: number, freed: number): string {
  const messages = `${replaced.toLocaleString('en-US')} message${replaced === 1 ? '' : 's'}`;
  const tokens = Math.max(0, freed).toLocaleString('en-US');
  return `↯ compacted ${messages}, ~${tokens} tokens freed`;
}

export function statusFor(streamText: string, committed: Item[]): string {
  if (streamText) return 'Responding…';
  const last = committed[committed.length - 1];
  if (last && last.kind === 'event' && last.event.type === 'tool_start') {
    return `Running ${last.event.name}…`;
  }
  return 'Thinking…';
}
