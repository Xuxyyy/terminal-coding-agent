import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {TraceRun, TraceScope, traceHost, type TraceRecord} from '../../core/trace.js';
import {startSession} from '../../core/store.js';
import {createSession, addTask} from '../../core/session.js';
import {runAgent} from '../../core/loop.js';
import {runHeadless} from '../../core/headless/run.js';
import {jsonLines, plainLines} from '../../core/headless/output.js';
import {fakeHost, fakeModel, finishChunk, reasoningChunk, streamOf, textChunk, toolCallChunk, usageChunk} from '../fakes.js';

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-trace-test-')); }
function readJsonLines<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

function records(trace: TraceRun): TraceRecord[] { return readJsonLines<TraceRecord>(trace.file); }

function completedSpans(saved: TraceRecord[]): TraceRecord[] {
  return saved.filter((record) => record.phase === 'start').map((record) => {
    const end = saved.find((candidate) => candidate.phase === 'end' && candidate.spanId === record.spanId);
    assert.ok(end, `missing end record for ${record.name}`);
    return {...record, outcome: end.outcome, durationMs: end.durationMs, data: {...record.data, ...end.data}};
  });
}

test('root spans have no parent; retry waits and cancellation keep identities and unknown costs', async () => {
  const dir = temp();
  try {
    const trace = new TraceRun(dir);
    const host = traceHost(fakeHost().host, trace.main);
    const begin = {type: 'model_attempt_start' as const, requestId: 'request', agentId: 'main', attempt: 1, startedAt: new Date().toISOString()};
    host.onEvent(begin);
    host.onEvent(begin);
    host.onEvent({type: 'thinking_delta', text: 'do not save reasoning', requestId: 'request', agentId: 'main', attempt: 1});
    host.onEvent({type: 'model_attempt', evidence: {...begin, outcome: 'failed', elapsedMs: 2, usage: null}});
    host.onEvent({type: 'model_retry', attempt: 2, total: 3, delayMs: 100, requestId: 'request'});
    host.onEvent({...begin, attempt: 2});
    host.onEvent({type: 'tool_start', id: 'interrupted', name: 'bash', args: {command: 'echo test'}});
    trace.finish('cancelled');
    const saved = records(trace);
    const root = saved.find((r) => r.phase === 'start' && r.name === 'run')!;
    assert.equal(root.parentSpanId, undefined);
    assert.equal(root.data?.costUSD, null);
    assert.equal(saved.filter((r) => r.name === 'model attempt' && r.phase === 'start').length, 2);
    assert.equal(saved.find((r) => r.name === 'retry wait' && r.phase === 'end')?.outcome, 'completed');
    assert.equal(saved.find((r) => r.name === 'tool: bash' && r.phase === 'end')?.outcome, 'cancelled');
    assert.ok(saved.every((r, at) => r.seq === at + 1 && Number.isFinite(r.offsetMs)));
    assert.ok(saved.filter((r) => r.phase === 'end').every((r) => r.durationMs! >= 0));
    assert.ok(!fs.readFileSync(trace.file, 'utf8').includes('do not save reasoning'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('judge retries stay in the judge scope and close their wait', () => {
  const dir = temp();
  try {
    const trace = new TraceRun(dir);
    const host = traceHost(fakeHost().host, trace.main.forAgent('main/judge'));
    host.onEvent({type: 'model_retry', requestId: 'judge', attempt: 2, total: 3});
    host.onEvent({type: 'model_attempt_start', requestId: 'judge', agentId: 'main/judge', attempt: 2, startedAt: new Date().toISOString()});
    trace.finish('done');
    const saved = records(trace);
    assert.equal(saved.find((r) => r.name === 'retry wait' && r.phase === 'end')?.outcome, 'completed');
    assert.ok(saved.filter((r) => r.name !== 'run').every((r) => r.agentId === 'main/judge'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('trace persistence failures do not break model execution', async () => {
  const dir = temp();
  try {
    const blocked = path.join(dir, 'file');
    fs.writeFileSync(blocked, 'not a directory');
    let warnings = 0;
    const trace = new TraceRun(path.join(blocked, 'child'), {}, () => { warnings++; });
    const fake = fakeHost();
    const host = traceHost(fake.host, trace.main);
    host.onEvent({type: 'error', message: 'test event'});
    assert.equal(fake.events.length, 1);
    trace.finish('done');
    assert.equal(warnings, 1);
    assert.match(trace.warning!, /execution continues/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('saved parent and parallel child tools keep assignment ancestry and transcript links', async () => {
  const root = temp();
  const home = temp();
  const store = startSession(root, home);
  try {
    fs.writeFileSync(path.join(root, 'input.txt'), 'small fact');
    const trace = new TraceRun(store.dir, {task: 'two readers'});
    const scope = new TraceScope(trace, 'main', trace.rootSpanId, undefined, 'session.jsonl');
    store.trace = scope;
    const session = createSession(root, 'test', 1_000_000);
    store.appendMessage(addTask(session, 'Use two children to read input.txt, then report.'));
    const fake = fakeHost();
    const host = traceHost({...fake.host, agentId: 'main'}, scope);
    const {choice} = fakeModel((_nth, body) => {
      const messages = (body as {messages: {role: string; content?: string; tool_calls?: unknown[]}[]}).messages;
      const child = messages[0]?.content?.includes('sub-agent') || messages.some((m) => m.content?.includes('child-reader-'));
      const toolResults = messages.filter((m) => m.role === 'tool');
      if (child) return toolResults.length
        ? streamOf(textChunk('small fact'), finishChunk('stop'), usageChunk(4, 2))
        : streamOf(toolCallChunk('read-'+messages.at(-1)?.content, 'read_file', '{"path":"input.txt"}'), finishChunk('tool_calls'), usageChunk(4, 2));
      if (toolResults.length) return streamOf(reasoningChunk('private reasoning'), textChunk('Both read the fact.'), finishChunk('stop'), usageChunk(5, 3));
      return streamOf(
        toolCallChunk('child-one', 'agent', JSON.stringify({description: 'First reader', prompt: 'child-reader-one: read input.txt', background: true}), 0),
        toolCallChunk('child-two', 'agent', JSON.stringify({description: 'Second reader', prompt: 'child-reader-two: read input.txt', background: true}), 1),
        finishChunk('tool_calls'), usageChunk(5, 3),
      );
    });
    await runAgent(session, choice, host, undefined, store, {maxSteps: 6});
    trace.finish('done');
    const saved = records(trace);
    const spans = completedSpans(saved);
    const assignments = spans.filter((s) => s.name === 'assignment');
    assert.equal(assignments.length, 2);
    assert.equal(new Set(assignments.map((s) => s.assignmentId)).size, 2);
    assert.ok(assignments.every((s) => s.outcome === 'completed'));
    for (const assignment of assignments) {
      const model = spans.find((s) => s.name === 'model attempt' && s.parentSpanId === assignment.spanId)!;
      const tool = spans.find((s) => s.name === 'tool: read_file' && s.parentSpanId === model?.spanId)!;
      assert.ok(model, 'child model attempt recorded before diagnostics filter');
      assert.ok(tool, 'child tool recorded before diagnostics filter');
      assert.equal(tool.agentId, assignment.agentId);
      assert.equal(tool.assignmentId, assignment.assignmentId);
      assert.ok(spans.some((s) => s.name === 'permission decision' && s.parentSpanId === tool.spanId));
      const log = fs.readFileSync(path.join(store.dir, tool.data!.transcript as string), 'utf8');
      assert.ok(log.includes(trace.runId));
      assert.ok(log.includes(model.spanId));
    }
    const rootModels = spans.filter((s) => s.name === 'model attempt' && s.agentId === 'main');
    assert.ok(rootModels.some((s) => typeof s.data?.firstTextMs === 'number'));
    assert.ok(rootModels.some((s) => typeof s.data?.firstProgressMs === 'number'));
    const next = new TraceRun(store.dir, {task: 'next task'});
    store.trace = new TraceScope(next, 'main', next.rootSpanId, undefined, 'session.jsonl');
    store.appendMessage({role: 'user', content: 'second task'});
    next.finish('done');
    next.finish('cancelled');
    const summary = fs.readFileSync(trace.summaryFile, 'utf8');
    assert.equal(summary.split(`Run ${trace.runId}\n`).length, 2);
    assert.equal(summary.split(`Run ${next.runId}\n`).length, 2);
    assert.match(summary, /Task: two readers/);
    assert.match(summary, /Task: next task/);
    assert.equal((summary.match(/^Run /gm) ?? []).length, 2);
    assert.equal(fs.statSync(trace.summaryFile).mode & 0o777, 0o600);
    const logs = readJsonLines<{kind: string; trace?: {runId: string}}>(path.join(store.dir, 'session.jsonl'));
    assert.equal(logs.at(-1)?.trace?.runId, next.runId);
    assert.notEqual(trace.runId, next.runId);
  } finally { store.close(); fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(home, {recursive: true, force: true}); }
});

test('headless traces persist without sessions and JSON output stays parseable', async () => {
  const home = temp();
  const root = temp();
  const old = process.env.ACC_HOME;
  process.env.ACC_HOME = home;
  try {
    const {choice} = fakeModel(() => streamOf(textChunk('answer'), finishChunk('stop'), usageChunk(2, 1)));
    const result = await runHeadless({root, task: 'answer', choice, policy: 'deny', maxSeconds: 2});
    assert.equal(result.stopped, 'done');
    assert.ok(fs.existsSync(result.trace!.path));
    assert.ok(result.trace!.path.includes(`${path.sep}traces${path.sep}`));
    assert.equal(JSON.parse(jsonLines(result, false)[0]).trace.runId, result.trace!.runId);
    assert.equal(result.trace!.summaryPath, path.join(path.dirname(result.trace!.path), 'trace.txt'));
    const parsed = JSON.parse(jsonLines(result, false)[0]);
    assert.equal(parsed.trace.path, result.trace!.path);
    assert.equal(parsed.trace.summaryPath, result.trace!.summaryPath);
    assert.equal(parsed.message, 'answer');
    assert.equal(plainLines(result).out, 'answer');
    assert.ok(plainLines(result).err.includes(`trace summary: ${result.trace!.summaryPath}`));
    assert.match(fs.readFileSync(result.trace!.summaryPath!, 'utf8'), /Status: done/);
    assert.equal(readJsonLines<TraceRecord>(result.trace!.path).at(-1)?.outcome, 'done');
    const untraced = await runHeadless({root, task: 'answer', choice, policy: 'deny', maxSeconds: 2, trace: false});
    assert.equal(untraced.trace, undefined);
  } finally { if (old === undefined) delete process.env.ACC_HOME; else process.env.ACC_HOME = old; fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(root, {recursive: true, force: true}); }
});

test('summary write failure preserves JSONL and contains throwing warning callbacks', () => {
  const dir = temp();
  try {
    let warnings = 0;
    const trace = new TraceRun(dir, {task: 'write summary'}, () => { warnings++; throw new Error('callback failure'); });
    fs.mkdirSync(trace.summaryFile);
    trace.finish('error');
    trace.finish('done');
    assert.equal(warnings, 1);
    assert.equal(trace.summaryPath, undefined);
    assert.match(trace.warning!, /JSONL trace remains available/);
    assert.equal(records(trace).at(-1)?.outcome, 'error');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('run cleanup labels remaining operation windows without claiming completed durations', () => {
  const dir = temp();
  try {
    for (const outcome of ['cancelled', 'timeout', 'error']) {
      const trace = new TraceRun(dir, {task: outcome});
      trace.start(trace.main, 'tool: bash');
      trace.finish(outcome);
      const saved = records(trace).filter((r) => r.runId === trace.runId);
      assert.equal(saved.find((r) => r.name === 'tool: bash' && r.phase === 'end')?.data?.durationKind, 'observed_window');
      const section = fs.readFileSync(trace.summaryFile, 'utf8').split(`Run ${trace.runId}\n`)[1];
      assert.match(section, /observed window .*\(end unconfirmed\)/);
      assert.match(section, new RegExp(`Status: ${outcome}`));
      assert.ok(!section.includes('NaN'));
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('headless summary failure reports a warning without a false summary path', async () => {
  const root = temp();
  try {
    const trace = new TraceRun(root, {task: 'answer'});
    fs.mkdirSync(trace.summaryFile);
    const {choice} = fakeModel(() => streamOf(textChunk('answer'), finishChunk('stop'), usageChunk(2, 1)));
    const result = await runHeadless({root, task: 'answer', choice, policy: 'deny', maxSeconds: 2, trace});
    assert.equal(result.stopped, 'done');
    assert.equal(result.trace!.summaryPath, undefined);
    assert.match(result.trace!.warning!, /JSONL trace remains available/);
    const output = JSON.parse(jsonLines(result, false)[0]);
    assert.equal(output.trace.summaryPath, undefined);
    assert.equal(output.trace.path, trace.file);
    assert.equal(output.message, 'answer');
    assert.ok(plainLines(result).err.some((line) => line.startsWith('warning: could not save timing summary')));
    assert.ok(!plainLines(result).err.some((line) => line.startsWith('trace summary:')));
    assert.equal(records(trace).at(-1)?.outcome, 'done');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('headless normal cancellation and an expired deadline save their timing sections', async () => {
  const root = temp();
  try {
    for (const outcome of ['cancelled', 'timeout']) {
      const controller = new AbortController();
      if (outcome === 'cancelled') controller.abort();
      const {choice, calls} = fakeModel(() => { throw new Error('model must not be called'); });
      const trace = new TraceRun(root, {task: outcome});
      const result = await runHeadless({root, task: outcome, choice, policy: 'deny', maxSeconds: 2, trace, signal: controller.signal, ...(outcome === 'timeout' ? {deadlineMs: Date.now() - 1} : {})});
      assert.equal(result.stopped, outcome);
      assert.equal(calls(), 0);
      assert.equal(result.trace!.summaryPath, trace.summaryFile);
      const section = fs.readFileSync(trace.summaryFile, 'utf8').split(`Run ${trace.runId}\n`)[1];
      assert.match(section, new RegExp(`Status: ${outcome}`));
      assert.equal(records(trace).filter((r) => r.runId === trace.runId).at(-1)?.outcome, outcome);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
