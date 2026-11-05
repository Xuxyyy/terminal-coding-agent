import assert from 'node:assert/strict';
import test from 'node:test';
import {formatTraceRun} from '../../core/trace-text.js';
import type {TraceRecord} from '../../core/trace.js';

function span(id: string, name: string, parent: string | undefined, at: number, duration: number | undefined, outcome: string | undefined, data: Record<string, unknown> = {}, agentId = 'main', assignmentId?: string): TraceRecord[] {
  const start: TraceRecord = {version: 1, runId: 'run-one', spanId: id, parentSpanId: parent, seq: at, timestamp: '2026-01-01T00:00:00.000Z', offsetMs: at, phase: 'start', name, agentId, assignmentId, data};
  return duration === undefined ? [start] : [start, {...start, seq: at + duration, offsetMs: at + duration, phase: 'end', durationMs: duration, outcome}];
}

test('timing tree shows nested child work with overlapping offsets and one wall duration', () => {
  const records = [
    ...span('root', 'run', undefined, 0, 1000, 'done', {task: 'Read a fact and report'}),
    ...span('model', 'model attempt', 'root', 0, 100, 'completed', {attempt: 1}),
    ...span('delegate', 'tool: agent', 'model', 100, 20, 'completed'),
    ...span('assignment', 'assignment', 'delegate', 110, 600, 'completed', {description: 'Read input'}, 'reader', 'job-one'),
    ...span('child-model', 'model attempt', 'assignment', 120, 200, 'completed', {attempt: 1}, 'reader', 'job-one'),
    ...span('read', 'tool: read_file', 'child-model', 320, 50, 'completed', {}, 'reader', 'job-one'),
    ...span('permission', 'permission decision', 'read', 320, 5, 'allowed', {tool: 'read_file'}, 'reader', 'job-one'),
    ...span('other', 'tool: write_file', 'model', 130, 100, 'completed'),
    ...span('retry', 'retry wait', 'root', 750, 50, 'completed', {attempt: 2}),
  ];
  const text = formatTraceRun(records, 'run-one');
  assert.equal(text, [
    'Run run-one',
    'Task: Read a fact and report',
    'Status: done | Wall time: 1.000 s',
    'Offsets are from run start. Parent relationships can overlap; durations are not added.',
    '└─ run [main] @+0.0 ms — duration 1.000 s — done',
    '   ├─ model attempt 1 [main] @+0.0 ms — duration 100.0 ms — completed',
    '   │  ├─ tool: agent [main] @+100.0 ms — duration 20.0 ms — completed',
    '   │  │  └─ assignment: Read input [reader; assignment job-one] @+110.0 ms — duration 600.0 ms — completed',
    '   │  │     └─ model attempt 1 [reader; assignment job-one] @+120.0 ms — duration 200.0 ms — completed',
    '   │  │        └─ tool: read_file [reader; assignment job-one] @+320.0 ms — duration 50.0 ms — completed',
    '   │  │           └─ permission: read_file [reader; assignment job-one] @+320.0 ms — duration 5.0 ms — allowed',
    '   │  └─ tool: write_file [main] @+130.0 ms — duration 100.0 ms — completed',
    '   └─ retry wait (attempt 2) [main] @+750.0 ms — duration 50.0 ms — completed',
    '', '',
  ].join('\n'));
  assert.equal(formatTraceRun([...records].reverse(), 'run-one'), text);
  assert.ok(!text.includes('{'));
});

test('failed, unconfirmed and missing end timings remain distinct', () => {
  const records = [
    ...span('root', 'run', undefined, 0, 100, 'cancelled', {task: 'Try work'}),
    ...span('failed', 'model attempt', 'root', 0, 20, 'failed', {attempt: 1}),
    ...span('cancelled', 'tool: bash', 'root', 20, 80, 'cancelled'),
    ...span('missing', 'assignment', 'root', 30, undefined, undefined),
  ];
  records.find((r) => r.spanId === 'cancelled' && r.phase === 'end')!.data = {durationKind: 'observed_window'};
  const text = formatTraceRun(records, 'run-one');
  assert.match(text, /duration 20\.0 ms — failed/);
  assert.match(text, /observed window 80\.0 ms \(end unconfirmed\) — cancelled/);
  assert.match(text, /duration unknown — incomplete/);
  assert.match(text, /Status: cancelled \| Wall time: 100\.0 ms/);
  const partial = formatTraceRun(records.filter((r) => r.phase !== 'end'), 'run-one');
  assert.match(partial, /Status: unknown \(run end missing\) \| Wall time: unknown/);
  assert.ok(!partial.includes('duration 0'));
});

test('one-line labels remove terminal controls and cross-run records stay separate', () => {
  const records = [
    ...span('root', 'run', undefined, 0, 10, 'done', {task: '\x1b[31mFirst\nTask\tname\x1b]0;title\x07\u202e'}),
    ...span('orphan', 'tool: read\nfile\x1b[0m', 'gone', 2, 3, 'failed'),
  ];
  const foreign = span('root', 'run', undefined, 0, 999, 'error', {task: 'Other run'}).map((r) => ({...r, runId: 'other'}));
  const text = formatTraceRun([...records, ...foreign], 'run-one');
  assert.match(text, /Task: First Task name\n/);
  assert.match(text, /tool: read file/);
  assert.match(text, /parent unavailable/);
  assert.ok(!text.includes('Other run'));
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/.test(text));
});
