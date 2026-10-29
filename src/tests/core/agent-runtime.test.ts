import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {spawnSync} from 'node:child_process';
import {AgentRuntime} from '../../core/agent-runtime.js';
import {AgentMailbox} from '../../core/agent-mailbox.js';
import {startSession, type SessionStore} from '../../core/store.js';
import {loadSubagent, listSubagents} from '../../core/subagent-store.js';
import {addTask, createSession, restoreMessages} from '../../core/session.js';
import {runAgent} from '../../core/loop.js';
import {subagent} from '../../core/tools/subagent.js';
import {sendMessage, waitAgents, stopAgent} from '../../core/tools/agent-messages.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';
import {toolsFor} from '../../core/tools/index.js';
import {fakeHost, fakeModel, streamOf, textChunk, finishChunk, toolCallChunk, usageChunk} from '../fakes.js';

const job = {description: 'check a fact', prompt: 'Find the requested fact.'};
const done = (text = 'child report') => streamOf(textChunk(text), finishChunk('stop'), usageChunk(2, 1));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return {promise, resolve};
}
function fixture(t: {after(fn: () => unknown): void}, response: Parameters<typeof fakeModel>[0] = () => done()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-agents-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-agents-home-'));
  const store = startSession(root, home);
  const f = fakeHost();
  const model = fakeModel(response);
  const agents = new AgentRuntime(f.host, store);
  const ctx: ToolContext = {root, store, host: f.host, agents, inboxId: 'main', choice: model.choice,
    allowed: new Set(), rules: {allow: [], ask: [], deny: []}, mode: 'auto-edits', sandbox: 'off', authorizationTasks: ['Check the fixture.']};
  t.after(async () => { await agents.close(); store.close(); fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(home, {recursive: true, force: true}); });
  return {root, home, store, ...f, model, agents, ctx};
}
function idOf(text: string): string { return /^agent_id: (.+)$/m.exec(text)![1]; }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail('condition did not become true');
}

for (const background of [undefined, true, false]) {
  test(`background ${background ?? 'omitted'} preserves return timing, persistence, and list discovery`, async (t) => {
    const entered = deferred();
    const gate = deferred();
    const f = fixture(t, () => ({async *[Symbol.asyncIterator]() {
      entered.resolve();
      await gate.promise;
      yield* done();
    }}));
    let returned = false;
    const pending = runTool([subagent], 'agent', JSON.stringify({...job, background}), f.ctx)
      .then((result) => { returned = true; return result; });
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(returned, background !== false);
      const listed = JSON.parse((await runTool([subagent], 'agent', '{"action":"list"}', f.ctx)).text);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'running');
      const id = listed[0].agent_id;
      assert.equal(loadSubagent(f.store, id).meta.background, background !== false);
      if (background !== false) assert.match((await pending).text, /status: running/);
      gate.resolve();
      const result = await pending;
      await until(() => !f.agents.running());
      const saved = loadSubagent(f.store, id);
      assert.equal(saved.meta.status, 'completed');
      assert.equal(saved.meta.background, background !== false);
      assert.match(saved.meta.result!.text, /child report/);
      assert.match(JSON.stringify(saved.messages), /Find the requested fact/);
      assert.equal(f.agents.mail.pending('main').length, background === false ? 0 : 1);
      if (background === false) assert.match(result.text, /status: completed[\s\S]*child report/);
    } finally {
      gate.resolve();
      await pending;
    }
  });
}

test('omitted background runs two children concurrently with main and final reports wake main automatically', async (t) => {
  const gate = deferred();
  let active = 0;
  let peak = 0;
  let parentRequests = 0;
  const f = fixture(t, (_n, body) => {
    const messages = (body as {messages: {content: string}[]}).messages;
    if (messages[0].content === 'parent') {
      parentRequests++;
      if (parentRequests === 1) return streamOf(
        toolCallChunk('a', 'agent', JSON.stringify(job)),
        toolCallChunk('b', 'agent', JSON.stringify({...job, prompt: 'Second fact'}), 1), finishChunk('tool_calls'));
      if (parentRequests === 2) { assert.equal(active, 2); gate.resolve(); return done('main worked concurrently'); }
      assert.match(JSON.stringify(messages), /child report/);
      return done('all verified');
    }
    return {async *[Symbol.asyncIterator]() {
      active++; peak = Math.max(peak, active);
      await gate.promise;
      active--;
      yield* done();
    }};
  });
  const session = createSession(f.root, 'parent', 1_000_000);
  f.store.appendMessage(addTask(session, 'Check both facts.'));
  await runAgent(session, f.model.choice, f.host, toolsFor('auto-edits'), f.store);
  assert.equal(peak, 2);
  assert.equal(parentRequests, 3);
  assert.equal(listSubagents(f.store).filter((meta) => meta.status === 'completed').length, 2);
  assert.equal(session.messages.filter((message) => message.role === 'user' && message.name === 'acc_agent').length, 2);
  assert.equal(session.usage.total, 12);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.dir, 'session.json'), 'utf8')).usage.total, 12);
});

test('active child gets ordered messages at a model boundary and refuses overlapping resume', async (t) => {
  const entered = deferred(); const gate = deferred(); const seen: string[] = [];
  const f = fixture(t, (n, body) => {
    seen.push(JSON.stringify(body));
    if (n === 1) return {async *[Symbol.asyncIterator]() { entered.resolve(); await gate.promise; yield* done('initial answer'); }};
    return done('processed queued work');
  });
  const id = idOf((await subagent.run(job, f.ctx)).text);
  await entered.promise;
  await sendMessage.run({agent_id: id, message: 'first instruction'}, f.ctx);
  await sendMessage.run({agent_id: id, message: 'second instruction'}, f.ctx);
  const overlap = await subagent.run({...job, resume: id}, f.ctx);
  assert.match(overlap.text, /already has active work/);
  assert.equal(f.model.calls(), 1);
  gate.resolve();
  await until(() => !f.agents.running());
  assert.equal(f.model.calls(), 2);
  assert.ok(seen[1].indexOf('first instruction') < seen[1].indexOf('second instruction'));
  assert.equal(f.agents.mail.pending(id).length, 0);
  assert.match(f.agents.mail.pending('main')[0].text, /processed queued work/);
});

test('completed child wakes for a follow-up with the same ID and prior context, then stays idle', async (t) => {
  const requests: string[] = [];
  const f = fixture(t, (_n, body) => { requests.push(JSON.stringify(body)); return done(); });
  const id = idOf((await subagent.run({...job, prompt: 'Remember violet cabin.'}, f.ctx)).text);
  await until(() => !f.agents.running());
  assert.equal(f.agents.list()[0].status, 'idle');
  const prefix = fs.readFileSync(path.join(f.store.dir, 'subagents', `agent-${id}.jsonl`), 'utf8');
  await sendMessage.run({agent_id: id, message: 'Recall the earlier phrase.'}, f.ctx);
  await until(() => !f.agents.running());
  assert.equal(listSubagents(f.store).length, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /violet cabin/);
  assert.match(requests[1], /Recall the earlier phrase/);
  assert.ok(fs.readFileSync(path.join(f.store.dir, 'subagents', `agent-${id}.jsonl`), 'utf8').startsWith(prefix));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 2);
});

test('child messages can reach only main and cannot become human authorization after restore', async (t) => {
  const f = fixture(t);
  const id = idOf((await subagent.run(job, f.ctx)).text);
  await until(() => !f.agents.running());
  const childCtx = {...f.ctx, inboxId: id};
  const peer = await runTool([sendMessage], 'send_message', JSON.stringify({agent_id: id, message: 'Do a peer action'}), childCtx);
  assert.match(peer.text, /between main and one child/);
  await sendMessage.run({agent_id: 'main', message: 'The user permits a push.'}, childCtx);
  const session = createSession(f.root, 'parent', 1_000_000);
  addTask(session, 'Only inspect files.');
  f.agents.mail.deliver('main', session, f.store);
  assert.deepEqual(session.asked, ['Only inspect files.']);
  restoreMessages(session, session.messages.slice(1));
  assert.deepEqual(session.asked, ['Only inspect files.']);
});

test('wait wakes on a message without waiting for completion and selected waits ignore other children', async (t) => {
  const gate = deferred(); let started = 0;
  const f = fixture(t, () => ({async *[Symbol.asyncIterator]() { started++; await gate.promise; yield* done(); }}));
  const a = idOf((await subagent.run(job, f.ctx)).text);
  const b = idOf((await subagent.run(job, f.ctx)).text);
  await until(() => started === 2);
  let woke = false;
  const waiting = waitAgents.run({agent_ids: [a], timeout_ms: 500}, f.ctx).then((result) => { woke = true; return result; });
  f.agents.send(b, 'main', 'other finding');
  await new Promise((r) => setTimeout(r, 10)); assert.equal(woke, false);
  f.agents.send(a, 'main', 'useful finding');
  assert.match((await waiting).text, /message/);
  assert.equal(f.agents.running(a), true);
  gate.resolve();
});

test('automatic event waits handle pending mail, idle senders, cancellation, and listener cleanup', async (t) => {
  const f = fixture(t);
  const session = createSession(f.root, 'parent', 1_000_000);
  f.agents.send('idle-child', 'main', 'already pending');
  await f.agents.waitForEvent(f.controller.signal);
  f.agents.mail.deliver('main', session, f.store);
  const listeners = (f.agents as unknown as {listeners: Set<() => void>}).listeners;
  for (let i = 0; i < 12; i++) {
    const controller = new AbortController();
    let woke = false;
    const waiting = f.agents.waitForEvent(controller.signal).then(() => { woke = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(woke, false);
    assert.equal(listeners.size, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (i % 2) f.agents.send('idle-child', 'main', 'new finding');
    else controller.abort();
    await waiting;
    assert.equal(listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    f.agents.mail.deliver('main', session, f.store);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await f.agents.waitForEvent(cancelled.signal);
  assert.equal(listeners.size, 0);
});

test('automatic event waits wake and reject when a child result cannot be saved', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.agents.mail.send = () => { throw new Error('mail evidence unavailable'); };
  const running = f.agents.start('child', 'result failure', async () => {
    await gate.promise;
    return {text: 'result'};
  }, true, 'assignment');
  const rejected = assert.rejects(running, /mail evidence unavailable/);
  const waiting = assert.rejects(f.agents.waitForEvent(f.controller.signal), /mail evidence unavailable/);
  gate.resolve();
  await Promise.all([rejected, waiting]);
  await assert.rejects(f.agents.waitForEvent(f.controller.signal), /mail evidence unavailable/);
});

test('stop interrupts several real shell tools, preserves pending mail, and messages do not restart them', async (t) => {
  const f = fixture(t, (n) => n <= 2
    ? streamOf(toolCallChunk(`sleep-${n}`, 'bash', JSON.stringify({command: 'sleep 20'})), finishChunk('tool_calls')) : done('resumed'));
  const a = idOf((await subagent.run(job, f.ctx)).text);
  const b = idOf((await subagent.run(job, f.ctx)).text);
  await until(() => listSubagents(f.store).every((meta) => JSON.stringify(loadSubagent(f.store, meta.id).messages).includes('sleep-')));
  await sendMessage.run({agent_id: a, message: 'Pending instruction'}, f.ctx);
  await stopAgent.run({agent_ids: [a, b]}, f.ctx);
  assert.deepEqual(f.agents.list().map((entry) => entry.status), ['interrupted', 'interrupted']);
  const calls = f.model.calls();
  await sendMessage.run({agent_id: a, message: 'Do not undo cancellation'}, f.ctx);
  assert.equal(f.model.calls(), calls);
  assert.equal(f.agents.mail.pending(a).length, 2);
  await subagent.run({...job, resume: a, prompt: 'Explicitly resume carefully.'}, f.ctx);
  await until(() => !f.agents.running());
  assert.match(JSON.stringify(loadSubagent(f.store, a).messages), /Pending instruction/);
  assert.match(JSON.stringify(loadSubagent(f.store, a).messages), /previous assignment did not complete/);
});

test('permission prompts are serialized across children and cancellation cannot grant queued approval', async (t) => {
  const f = fixture(t);
  const first = deferred(); let active = 0; let peak = 0; let count = 0;
  f.host.confirm = async (_request, signal) => {
    active++; count++; peak = Math.max(peak, active);
    await Promise.race([first.promise, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {once: true}))]);
    active--;
    return signal?.aborted ? 'deny' : 'once';
  };
  const one = new AbortController(); const two = new AbortController();
  const request = {command: 'protected action', reason: 'needs review', suppressible: false};
  const a = f.agents.confirm(request, one.signal, 'a');
  const b = f.agents.confirm(request, two.signal, 'b');
  await until(() => count === 1);
  two.abort(); first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ['once', 'deny']);
  assert.equal(peak, 1); assert.equal(count, 1);
});

test('delivery saved before acknowledgement is not repeated after compaction and journal reopen', (t) => {
  const f = fixture(t);
  const event = f.agents.send('child', 'main', 'Keep this instruction.');
  const session = createSession(f.root, 'parent', 1_000_000);
  f.agents.mail.deliver('main', session, f.store);
  f.store.appendCompact({role: 'assistant', content: 'summary'}, 1, [{role: 'assistant', content: 'summary'}]);
  const file = path.join(f.store.dir, 'agent-mail.jsonl');
  const records = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line && JSON.parse(line).kind !== 'delivered');
  fs.writeFileSync(file, records.join('\n') + '\n');
  const reopened = new AgentMailbox(f.store);
  const fresh = createSession(f.root, 'parent', 1_000_000);
  reopened.deliver('main', fresh, f.store);
  assert.equal(fresh.messages.length, 1);
  assert.equal(reopened.pending('main').length, 0);
  assert.equal(new AgentMailbox(f.store).pending('main').length, 0);
  assert.ok(event.id);
});

test('a torn mail tail is recovered once and future messages remain readable', (t) => {
  const f = fixture(t);
  f.agents.send('child', 'main', 'first');
  fs.appendFileSync(path.join(f.store.dir, 'agent-mail.jsonl'), '{"kind":"sent","eve');
  const reopened = new AgentMailbox(f.store);
  reopened.send('child', 'main', 'second');
  assert.deepEqual(new AgentMailbox(f.store).pending('main').map((mail) => mail.text), ['first', 'second']);
});

test('process restart retains ordered pending messages without scheduling interrupted work', async (t) => {
  const gate = deferred();
  const f = fixture(t, () => ({async *[Symbol.asyncIterator]() { await gate.promise; yield* done(); }}));
  const id = idOf((await subagent.run(job, f.ctx)).text);
  f.agents.send('main', id, 'first pending'); f.agents.send('main', id, 'second pending');
  const script = `
    import assert from 'node:assert/strict';
    import {AgentRuntime} from ${JSON.stringify(new URL('../../core/agent-runtime.js', import.meta.url).href)};
    import {fakeHost} from ${JSON.stringify(new URL('../fakes.js', import.meta.url).href)};
    const runtime = new AgentRuntime(fakeHost().host, {id: ${JSON.stringify(f.store.id)}, dir: ${JSON.stringify(f.store.dir)}});
    assert.equal(runtime.list()[0].status, 'interrupted');
    assert.equal(runtime.running(), false);
    assert.deepEqual(runtime.mail.pending(${JSON.stringify(id)}).map(m => m.text), ['first pending', 'second pending']);
    assert.equal(runtime.mail.pending('main')[0].kind, 'interrupted');
  `;
  const child = spawnSync(process.execPath, ['--import', new URL('../offline.js', import.meta.url).pathname, '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10_000});
  assert.equal(child.status, 0, child.stderr);
  gate.resolve();
});

test('a completed result lost before journal append is recovered exactly once from metadata', async (t) => {
  const f = fixture(t);
  await subagent.run(job, f.ctx); await until(() => !f.agents.running());
  const file = path.join(f.store.dir, 'agent-mail.jsonl');
  fs.writeFileSync(file, '');
  const one = new AgentRuntime(f.host, f.store);
  const two = new AgentRuntime(f.host, f.store);
  assert.equal(one.mail.pending('main').length, 1);
  assert.equal(two.mail.pending('main').length, 1);
  assert.match(two.mail.pending('main')[0].text, /child report/);
  assert.deepEqual(two.mail.pending('main')[0].usage, {prompt: 2, completion: 1, total: 3});
});

test('mail storage failure stops delivery before another model call', async (t) => {
  const f = fixture(t);
  f.agents.send('child', 'main', 'must be saved');
  const session = createSession(f.root, 'parent', 1_000_000);
  const broken: SessionStore = {...f.store, appendStep() { throw new Error('mail disk unavailable'); }};
  await assert.rejects(runAgent(session, f.model.choice, f.host, [], broken, {agents: f.agents, inboxId: 'main', durableTools: true}), /mail disk unavailable/);
  assert.equal(f.model.calls(), 0);
  assert.equal(f.agents.mail.pending('main').length, 1);
});

test('stopping a queued permission waiter returns before another agent answers and keeps the queue exclusive', async (t) => {
  const f = fixture(t);
  const first = deferred(); let count = 0;
  f.host.confirm = async () => { count++; if (count === 1) await first.promise; return 'once'; };
  const request = {command: 'action', reason: 'review', suppressible: false};
  const a = f.agents.confirm(request, new AbortController().signal, 'a');
  const second = new AbortController();
  const b = f.agents.confirm(request, second.signal, 'b');
  const c = f.agents.confirm(request, new AbortController().signal, 'c');
  await until(() => count === 1);
  second.abort();
  assert.equal(await b, 'deny');
  assert.equal(count, 1);
  first.resolve();
  assert.deepEqual(await Promise.all([a, c]), ['once', 'once']);
  assert.equal(count, 2);
});

test('a completion journal write failure becomes a runtime failure and keeps the saved result recoverable', async (t) => {
  const entered = deferred(); const gate = deferred();
  const f = fixture(t, () => ({async *[Symbol.asyncIterator]() { entered.resolve(); await gate.promise; yield* done(); }}));
  const id = idOf((await subagent.run(job, f.ctx)).text);
  await entered.promise;
  const file = path.join(f.store.dir, 'agent-mail.jsonl');
  fs.mkdirSync(file);
  gate.resolve();
  await until(() => !f.agents.running());
  assert.throws(() => f.agents.check(), /EISDIR/);
  assert.match(loadSubagent(f.store, id).meta.result!.text, /child report/);
  fs.rmdirSync(file);
  const recovered = new AgentRuntime(f.host, f.store);
  assert.equal(recovered.mail.pending('main').length, 1);
});

test('mail arriving while a child closes its shell manager starts one follow-up turn', async (t) => {
  const closing = deferred(); const gate = deferred();
  const f = fixture(t);
  let forks = 0;
  const backgroundTasks = {fork() {
    const first = ++forks === 1;
    return {drain: () => [], unverifiedServices: () => [], hasPending: () => false,
      async close() { if (first) { closing.resolve(); await gate.promise; } return []; }};
  }} as unknown as NonNullable<ToolContext['backgroundTasks']>;
  const ctx = {...f.ctx, backgroundTasks};
  const id = idOf((await subagent.run(job, ctx)).text);
  await closing.promise;
  await sendMessage.run({agent_id: id, message: 'Follow-up during cleanup'}, ctx);
  gate.resolve();
  await until(() => f.model.calls() === 2 && !f.agents.running());
  assert.equal(listSubagents(f.store).length, 1);
  assert.equal(f.agents.mail.pending(id).length, 0);
});

test('restored live delivery after a saved-message/acknowledgement gap does not add usage twice', (t) => {
  const f = fixture(t);
  f.agents.mail.send('child', 'main', 'saved result', 'result', 'test-result', {prompt: 9, completion: 2, total: 11});
  const first = createSession(f.root, 'parent', 1_000_000);
  f.agents.mail.deliver('main', first, f.store);
  const file = path.join(f.store.dir, 'agent-mail.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((line) => line && JSON.parse(line).kind !== 'delivered').join('\n') + '\n');
  const stale = createSession(f.root, 'parent', 1_000_000);
  assert.deepEqual(new AgentMailbox(f.store).deliver('main', stale, f.store), []);
  assert.match(JSON.stringify(stale.messages), /saved result/);
  assert.equal(stale.messages.length, 2);
});

test('queued instructions survive automatic compaction during an active child assignment', async (t) => {
  const compacting = deferred(); const gate = deferred(); const bodies: string[] = [];
  const f = fixture(t, (n, body) => {
    bodies.push(JSON.stringify(body));
    if (n === 1) return streamOf(toolCallChunk('read', 'read_file', '{"path":"notes.txt"}'), finishChunk('tool_calls'), usageChunk(900_000, 1));
    if (n === 2) return {async *[Symbol.asyncIterator]() {
      compacting.resolve(); await gate.promise;
      yield* done('The original assignment asks for the fixture fact. The file says violet cabin. No actions are pending except reporting this fact and processing new messages from main.');
    }};
    return done('compacted and processed');
  });
  fs.writeFileSync(path.join(f.root, 'notes.txt'), 'violet cabin');
  const id = idOf((await subagent.run({...job, prompt: 'Original assignment: inspect notes and report the fact.'}, f.ctx)).text);
  await compacting.promise;
  await sendMessage.run({agent_id: id, message: 'Queued while compacting: include the color.'}, f.ctx);
  gate.resolve();
  await until(() => !f.agents.running());
  assert.equal(f.model.calls(), 4);
  assert.match(bodies.at(-1)!, /Original assignment/);
  assert.match(bodies.at(-1)!, /Queued while compacting/);
  assert.equal(f.agents.mail.pending(id).length, 0);
  const log = fs.readFileSync(path.join(f.store.dir, 'subagents', `agent-${id}.jsonl`), 'utf8');
  assert.ok(log.includes('"kind":"compact"'));
});

test('parent cancellation stops active children and cannot be reversed by a child message', async (t) => {
  const f = fixture(t, () => streamOf(toolCallChunk('sleep', 'bash', '{"command":"sleep 20"}'), finishChunk('tool_calls'), usageChunk(7, 2)));
  const id = idOf((await subagent.run(job, f.ctx)).text);
  await until(() => JSON.stringify(loadSubagent(f.store, id).messages).includes('"sleep"'));
  f.controller.abort();
  await f.agents.close();
  assert.equal(loadSubagent(f.store, id).meta.status, 'interrupted');
  await assert.rejects(sendMessage.run({agent_id: 'main', message: 'Continue anyway'}, {...f.ctx, inboxId: id}), /cancelled or closed/);
});

test('a malformed complete journal stops the parent with a readable error before model execution', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.store.dir, 'agent-mail.jsonl'), '{invalid record}\n');
  const session = createSession(f.root, 'parent', 1_000_000);
  await runAgent(session, f.model.choice, f.host, [], f.store);
  assert.equal(f.model.calls(), 0);
  assert.ok(f.events.some((event) => event.type === 'error' && event.message.includes('agent mail journal is unreadable')));
});

test('restarting main repairs an unfinished tool batch before new user input without replaying actions', async (t) => {
  const f = fixture(t);
  const session = createSession(f.root, 'parent', 1_000_000);
  f.store.appendMessage(addTask(session, 'Original work.'));
  session.messages.push({role: 'assistant', content: '', tool_calls: [
    {id: 'known', type: 'function', function: {name: 'bash', arguments: '{"command":"printf known"}'}},
    {id: 'missing', type: 'function', function: {name: 'bash', arguments: '{"command":"touch repeated.txt"}'}},
  ]}, {role: 'tool', tool_call_id: 'known', content: 'saved known result'});
  f.store.appendStep(session.messages, {prompt: 5, completion: 1, total: 6});
  f.store.appendMessage(addTask(session, 'Continue carefully.'));
  f.store.seed(session.messages);
  const original = fs.readFileSync(path.join(f.store.dir, 'session.jsonl'), 'utf8');
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {runAgent} from ${JSON.stringify(new URL('../../core/loop.js', import.meta.url).href)};
    import {createSession, restoreMessages} from ${JSON.stringify(new URL('../../core/session.js', import.meta.url).href)};
    import {messagesOf, readRecords} from ${JSON.stringify(new URL('../../core/records.js', import.meta.url).href)};
    import {transcriptStore} from ${JSON.stringify(new URL('../../core/transcript-store.js', import.meta.url).href)};
    import {fakeHost, fakeModel, streamOf, textChunk, finishChunk} from ${JSON.stringify(new URL('../fakes.js', import.meta.url).href)};
    const root = ${JSON.stringify(f.root)}, dir = ${JSON.stringify(f.store.dir)};
    let saw = 0;
    const model = fakeModel((_n, body) => {
      const messages = body.messages;
      const call = messages.findIndex(m => m.role === 'assistant' && m.tool_calls);
      assert.equal(messages[call + 1].content, 'saved known result');
      assert.equal(messages[call + 2].tool_call_id, 'missing');
      assert.match(messages[call + 2].content, /Execution is uncertain/);
      assert.equal(messages[call + 3].content, 'Continue carefully.');
      saw++;
      return streamOf(textChunk('inspected, no replay'), finishChunk('stop'));
    });
    for (let round = 0; round < 2; round++) {
      const session = createSession(root, 'parent', 1_000_000);
      restoreMessages(session, messagesOf(readRecords(dir)));
      const store = transcriptStore(dir, ${JSON.stringify(f.store.id)}, () => {}, () => {});
      store.seed(session.messages);
      await runAgent(session, model.choice, fakeHost().host, [], store);
      store.close();
    }
    assert.equal(saw, 2);
    assert.equal(messagesOf(readRecords(dir)).filter(m => m.role === 'tool' && m.tool_call_id === 'missing').length, 1);
    assert.equal(fs.existsSync(root + '/repeated.txt'), false);
  `;
  const child = spawnSync(process.execPath, ['--import', new URL('../offline.js', import.meta.url).pathname, '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10_000});
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.readFileSync(path.join(f.store.dir, 'session.jsonl'), 'utf8').startsWith(original));
});

test('a failed save of parent uncertain outcomes prevents another model request', async (t) => {
  const f = fixture(t);
  const session = createSession(f.root, 'parent', 1_000_000);
  session.messages.push({role: 'assistant', content: '', tool_calls: [{id: 'missing', type: 'function', function: {name: 'agent', arguments: '{}'}}]});
  const broken = {...f.store, appendStep() { throw new Error('parent repair unavailable'); }};
  await runAgent(session, f.model.choice, f.host, [], broken);
  assert.equal(f.model.calls(), 0);
  assert.ok(f.events.some((event) => event.type === 'error' && event.message.includes('parent repair unavailable')));
});
