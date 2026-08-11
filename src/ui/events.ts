import path from 'node:path';

export type DiffRow = {
  kind: 'context' | 'add' | 'remove' | 'gap';
  line?: number;
  text?: string;
};

export type DiffPayload = {
  path: string;
  rows: DiffRow[];
  hidden: number;
  added: number;
  removed: number;
};

export type Usage = {prompt: number; completion: number; total: number};

export type AgentEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'tool_start'; id: string; name: string; args: unknown}
  | {
      type: 'tool_end';
      id: string;
      name: string;
      result: string;
      diff: DiffPayload | null;
    }
  | {type: 'turn_end'; usage: Usage}
  | {type: 'error'; message: string};

export type PermissionInfo = {id: string; label: string};

export type ReadyInfo = {
  workspace: string;
  sandbox: boolean;
  model: {id: string; label: string};
  permission: PermissionInfo;
};

export type ContextStatus = {used: number; budget: number};

export type HeaderItem = {
  kind: 'header';
  workspaceRoot: string;
  ready?: ReadyInfo;
};
export type TextItem = {kind: 'text'; text: string};
export type TaskItem = {kind: 'task'; text: string};
export type NoticeItem = {kind: 'notice'; text: string};
export type ContextItem = {kind: 'context'} & ContextStatus;
export type EventItem = {kind: 'event'; event: AgentEvent};

export type Item =
  | HeaderItem
  | TextItem
  | TaskItem
  | NoticeItem
  | ContextItem
  | EventItem;

export type ConfirmDecision = 'once' | 'session' | 'deny';

export type ConfirmRequest = {
  command: string;
  reason: string;
  suppressible: boolean;
};

export type Phase =
  | {kind: 'idle'}
  | {kind: 'busy'}
  | {kind: 'confirming'; request: ConfirmRequest}
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
    return `lines ${Number(range[2]).toLocaleString('en-US')}–${Number(range[3]).toLocaleString('en-US')} of ${Number(range[1]).toLocaleString('en-US')}`;
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

export function contextReadout(
  used: number,
  budget: number,
): {line: string; bar: string} {
  const pct = budget > 0 ? used / budget : 0;
  const filled = Math.max(0, Math.min(20, Math.floor(pct * 20)));
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const line = `context: ${used.toLocaleString('en-US')} / ${budget.toLocaleString('en-US')} tokens (${Math.round(pct * 100)}%)`;
  return {line, bar};
}

export function statusFor(streamText: string, committed: Item[]): string {
  if (streamText) return 'Responding…';
  const last = committed[committed.length - 1];
  if (last && last.kind === 'event' && last.event.type === 'tool_start') {
    return `Running ${last.event.name}…`;
  }
  return 'Thinking…';
}
