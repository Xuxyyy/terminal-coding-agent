import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AgentEvent, Host} from './host.js';
import {accHome, makeDir, projectDir} from './projects.js';
import {formatTraceRun} from './trace-text.js';

export type TraceLink = {runId: string; agentId: string; assignmentId?: string; spanId: string};
export type TraceRecord = TraceLink & {
  version: 1; seq: number; timestamp: string; offsetMs: number;
  phase: 'start' | 'end' | 'event'; name: string; parentSpanId?: string;
  durationMs?: number; outcome?: string; data?: Record<string, unknown>;
};

type OpenSpan = {scope: TraceScope; name: string; start: number; parentSpanId?: string};

export class TraceRun {
  readonly runId = randomUUID();
  readonly rootSpanId = randomUUID();
  readonly file: string;
  readonly summaryFile: string;
  summaryPath?: string;
  private started = performance.now();
  private seq = 0;
  private disabled = false;
  private finished = false;
  private seen = new WeakSet<object>();
  private open = new Map<string, OpenSpan>();
  private models = new Map<string, string>();
  private retries = new Map<string, string>();
  private records: TraceRecord[] = [];
  readonly main: TraceScope;
  warning?: string;

  constructor(dir: string, data: Record<string, unknown> = {}, private onWarning?: (message: string) => void) {
    this.file = path.join(dir, 'trace.jsonl');
    this.summaryFile = path.join(dir, 'trace.txt');
    this.main = new TraceScope(this, 'main', this.rootSpanId);
    try {
      makeDir(dir);
      if (fs.existsSync(this.file)) {
        const fd = fs.openSync(this.file, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const last = Buffer.alloc(1);
          if (size && fs.readSync(fd, last, 0, 1, size - 1) && last[0] !== 10) fs.appendFileSync(this.file, '\n');
        } finally { fs.closeSync(fd); }
      }
    } catch { this.fail(); }
    this.start(this.main, 'run', {...data, costUSD: null}, null, this.rootSpanId);
  }

  static headless(workspace: string, data: Record<string, unknown>, onWarning?: (message: string) => void): TraceRun {
    return new TraceRun(path.join(projectDir(workspace, accHome()), 'traces', randomUUID()), {workspace, mode: 'headless', ...data}, onWarning);
  }

  private fail(): void {
    if (this.disabled) return;
    this.disabled = true;
    this.warning = 'could not save execution trace; execution continues';
    try { this.onWarning?.(this.warning); } catch {}
  }

  private write(scope: TraceScope, record: Omit<TraceRecord, keyof TraceLink | 'version' | 'seq' | 'timestamp' | 'offsetMs'> & {spanId: string}): void {
    if (this.disabled || this.finished) return;
    const value: TraceRecord = {
      version: 1, seq: ++this.seq, timestamp: new Date().toISOString(),
      offsetMs: performance.now() - this.started, runId: this.runId, agentId: scope.agentId,
      ...(scope.assignmentId ? {assignmentId: scope.assignmentId} : {}), ...record,
    };
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(value)}\n`, {mode: 0o600});
      this.records.push(value);
    } catch { this.fail(); }
  }

  start(scope: TraceScope, name: string, data?: Record<string, unknown>, parentSpanId: string | null = scope.parentSpanId, id = randomUUID()): string {
    if (this.finished) return id;
    this.open.set(id, {scope, name, start: performance.now(), parentSpanId: parentSpanId ?? undefined});
    this.write(scope, {phase: 'start', name, spanId: id, ...(parentSpanId ? {parentSpanId} : {}), ...(data ? {data} : {})});
    return id;
  }

  end(id: string, outcome: string, data?: Record<string, unknown>): void {
    const span = this.open.get(id);
    if (!span) return;
    this.open.delete(id);
    this.write(span.scope, {phase: 'end', name: span.name, spanId: id, parentSpanId: span.parentSpanId, durationMs: performance.now() - span.start, outcome, ...(data ? {data} : {})});
  }

  event(scope: TraceScope, name: string, data?: Record<string, unknown>): void {
    this.write(scope, {phase: 'event', name, spanId: randomUUID(), parentSpanId: scope.parentSpanId, ...(data ? {data} : {})});
  }

  observe(scope: TraceScope, event: AgentEvent): void {
    if (this.seen.has(event)) return;
    this.seen.add(event);
    if (event.type === 'text_delta') {
      if (!scope.transcript) scope.text = (scope.text + event.text).slice(0, 12000);
      return;
    }
    if (event.type === 'thinking_delta') return;
    if (event.type === 'model_attempt_start') {
      const key = `${event.agentId}:${event.requestId}`;
      const waiting = this.retries.get(key);
      if (waiting) { this.end(waiting, 'completed'); this.retries.delete(key); }
      const id = this.start(scope.forAgent(event.agentId), 'model attempt', {requestId: event.requestId, attempt: event.attempt, startedAt: event.startedAt, transcript: scope.transcript}, scope.compactSpan ?? scope.parentSpanId);
      this.models.set(`${key}:${event.attempt}`, id);
      scope.latestModel = id;
      scope.text = '';
      return;
    }
    if (event.type === 'model_attempt') {
      const {partial, ...evidence} = event.evidence;
      const key = `${evidence.agentId}:${evidence.requestId}:${evidence.attempt}`;
      const id = this.models.get(key);
      if (id) this.end(id, evidence.outcome, {...evidence, ...(!scope.transcript ? {text: scope.text, textTruncated: scope.text.length === 12000} : {}), ...(partial ? {partial: {contentChars: partial.content.length, reasoningChars: partial.reasoning?.length ?? 0, toolCalls: partial.toolCalls.map(({id, name}) => ({id, name}))}} : {}), costUSD: null});
      return;
    }
    if (event.type === 'model_retry') {
      const agentId = scope.agentId;
      const key = `${agentId}:${event.requestId}`;
      const id = this.start(scope, 'retry wait', {...event}, scope.compactSpan ?? scope.parentSpanId);
      this.retries.set(key, id);
      return;
    }
    if (event.type === 'tool_start') {
      const id = this.start(scope, `tool: ${event.name}`, {toolCallId: event.id, transcript: scope.transcript, ...(!scope.transcript ? {args: event.args} : {})}, scope.latestModel ?? scope.parentSpanId);
      scope.tools.set(event.id, id);
      return;
    }
    if (event.type === 'tool_end') {
      const id = scope.tools.get(event.id);
      if (id) this.end(id, event.failure ? event.result.includes('[interrupted by the user]') ? 'cancelled' : 'failed' : 'completed', {execution: event.execution, resultChars: event.result.length, ...(scope.transcript ? {} : {result: event.result.slice(0, 12000)})});
      scope.tools.delete(event.id);
      return;
    }
    if (event.type === 'compact_start') { scope.compactSpan = this.start(scope, 'compaction', {transcript: scope.transcript}); return; }
    if (event.type === 'compact_end') {
      if (scope.compactSpan) this.end(scope.compactSpan, event.replaced ? 'completed' : 'failed', {...event});
      scope.compactSpan = undefined;
      return;
    }
    if (event.type === 'model_request_start') return;
    this.event(scope, event.type, {...event});
  }

  finish(outcome: string, data?: Record<string, unknown>): void {
    if (this.finished) return;
    for (const id of [...this.open.keys()].reverse()) {
      if (id !== this.rootSpanId) this.end(id, outcome === 'cancelled' || outcome === 'timeout' ? outcome : 'unfinished', {durationKind: 'observed_window'});
    }
    this.end(this.rootSpanId, outcome, data);
    this.finished = true;
    if (!this.disabled) {
      try {
        const text = formatTraceRun(this.records, this.runId);
        const file = fs.openSync(this.summaryFile, 'a', 0o600);
        try {
          fs.fchmodSync(file, 0o600);
          fs.writeFileSync(file, text);
        } finally { fs.closeSync(file); }
        this.summaryPath = this.summaryFile;
      } catch {
        this.warning = 'could not save timing summary; JSONL trace remains available';
        try { this.onWarning?.(this.warning); } catch {}
      }
    }
    this.records = [];
  }
}

export class TraceScope {
  text = '';
  latestModel?: string;
  compactSpan?: string;
  tools = new Map<string, string>();
  constructor(readonly run: TraceRun, readonly agentId: string, readonly parentSpanId: string, readonly assignmentId?: string, readonly transcript?: string) {}
  child(agentId: string, assignmentId: string, parentSpanId = this.parentSpanId, transcript?: string): TraceScope {
    return new TraceScope(this.run, agentId, parentSpanId, assignmentId, transcript);
  }
  under(parentSpanId: string): TraceScope { return new TraceScope(this.run, this.agentId, parentSpanId, this.assignmentId, this.transcript); }
  forAgent(agentId: string): TraceScope { return agentId === this.agentId ? this : new TraceScope(this.run, agentId, this.parentSpanId, this.assignmentId, this.transcript); }
  reference(): TraceLink { return {runId: this.run.runId, agentId: this.agentId, ...(this.assignmentId ? {assignmentId: this.assignmentId} : {}), spanId: this.latestModel ?? this.parentSpanId}; }
  async operation<T>(name: string, data: Record<string, unknown>, action: (scope: TraceScope) => Promise<T>, outcome: (result: T) => string = () => 'completed'): Promise<T> {
    const id = this.run.start(this, name, data);
    try { const result = await action(this.under(id)); this.run.end(id, outcome(result)); return result; }
    catch (error) { this.run.end(id, 'failed', {message: (error as Error).message}); throw error; }
  }
}

export function traceHost(host: Host, scope = host.trace): Host {
  if (!scope || host.traceObserver === scope) return host;
  return {...host, trace: scope, traceObserver: scope, onEvent(event) { scope.run.observe(scope, event); host.onEvent(event); }};
}
