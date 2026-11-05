import type {TraceRecord} from './trace.js';

type Node = {start: TraceRecord; end?: TraceRecord; children: Node[]; orphan?: boolean};

function lineText(value: unknown, fallback = 'unknown', limit = 180): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const text = String(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : fallback;
}

function milliseconds(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
  return value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(3)} s`;
}

function label(record: TraceRecord): string {
  const data = record.data;
  if (record.name.startsWith('tool:')) return lineText(record.name);
  if (record.name === 'model attempt') return `model attempt ${lineText(data?.attempt)}`;
  if (record.name === 'assignment') return `assignment: ${lineText(data?.description, 'child work')}`;
  if (record.name === 'permission decision') return `permission: ${lineText(data?.tool, 'decision')}`;
  if (record.name === 'retry wait') return `retry wait (attempt ${lineText(data?.attempt)})`;
  if (record.name === 'recovery') return `recovery: ${lineText(data?.kind)}`;
  return lineText(record.name.replace(/_/g, ' '));
}

function identifier(value: string): string {
  const text = lineText(value);
  return text.length > 16 ? text.slice(0, 12) + '…' : text;
}

function timing(node: Node): string {
  if (node.start.phase === 'event') return 'event';
  if (!node.end) return 'duration unknown';
  const duration = milliseconds(node.end.durationMs);
  return node.end.data?.durationKind === 'observed_window'
    ? `observed window ${duration} (end unconfirmed)`
    : `duration ${duration}`;
}

export function formatTraceRun(records: readonly TraceRecord[], runId: string): string {
  const run = records.filter((record) => record.runId === runId);
  const ends = new Map<string, TraceRecord>();
  for (const record of run) if (record.phase === 'end' && !ends.has(record.spanId)) ends.set(record.spanId, record);
  const nodes = new Map<string, Node>();
  const ordered = run.filter((record) => record.phase !== 'end' && !['run_start', 'turn_end'].includes(record.name))
    .sort((a, b) => a.offsetMs - b.offsetMs || a.seq - b.seq);
  for (const start of ordered) if (!nodes.has(start.spanId)) nodes.set(start.spanId, {start, end: ends.get(start.spanId), children: []});
  const root = [...nodes.values()].find((node) => node.start.name === 'run' && !node.start.parentSpanId);
  const top: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.start.parentSpanId ? nodes.get(node.start.parentSpanId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else {
      node.orphan = Boolean(node.start.parentSpanId);
      top.push(node);
    }
  }
  const status = lineText(root?.end?.outcome, root?.end ? 'unknown' : 'unknown (run end missing)');
  const lines = [
    `Run ${lineText(runId)}`,
    `Task: ${lineText(root?.start.data?.task, '(task label unavailable)')}`,
    `Status: ${status} | Wall time: ${milliseconds(root?.end?.durationMs)}`,
    'Offsets are from run start. Parent relationships can overlap; durations are not added.',
  ];
  const visited = new Set<string>();
  const draw = (node: Node, prefix: string, last: boolean, depth: number): void => {
    if (visited.has(node.start.spanId)) return;
    visited.add(node.start.spanId);
    const record = node.start;
    const identity = identifier(record.agentId) + (record.assignmentId ? `; assignment ${identifier(record.assignmentId)}` : '');
    const outcome = lineText(node.end?.outcome, record.phase === 'event' ? 'event' : 'incomplete');
    lines.push(`${prefix}${last ? '└─' : '├─'} ${label(record)} [${identity}] @+${milliseconds(record.offsetMs)} — ${timing(node)} — ${outcome}${node.orphan ? ' (parent unavailable)' : ''}`);
    if (depth >= 80 && node.children.length) { lines.push(`${prefix}   … deeper relationships omitted`); return; }
    node.children.forEach((child, at) => draw(child, prefix + (last ? '   ' : '│  '), at === node.children.length - 1, depth + 1));
  };
  top.forEach((node, at) => draw(node, '', at === top.length - 1, 0));
  for (const node of nodes.values()) if (!visited.has(node.start.spanId)) { node.orphan = true; draw(node, '', true, 0); }
  if (!nodes.size) lines.push('No operation records available.');
  return lines.join('\n') + '\n\n';
}
