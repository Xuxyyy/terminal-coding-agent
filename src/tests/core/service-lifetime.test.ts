import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {BackgroundTasks} from '../../core/background.js';
import type {AgentEvent} from '../../core/host.js';
import {runCommand} from '../../core/sandbox/run.js';
import {backgroundBash} from '../../core/tools/bash.js';
import {taskHandoff} from '../../core/tools/tasks.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';
import {fakeHost} from '../fakes.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
const sleeper = node("console.log('service log');console.error('service error');setInterval(()=>{},1000)");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-lifetime-'));
  const {host, controller} = fakeHost();
  const events: AgentEvent[] = [];
  const tasks = new BackgroundTasks({signal: controller.signal, onEvent: (event) => events.push(event), directory: path.join(root, 'tasks')});
  const runtimes: string[] = [];
  const pids: number[] = [];
  t.after(async () => {
    await tasks.close('test cleanup');
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    for (const runtime of runtimes) fs.rmSync(runtime, {recursive: true, force: true});
    fs.rmSync(root, {recursive: true, force: true});
  });
  const ctx: ToolContext = {root, host, mode: 'auto-edits', rules: {allow: [], ask: [], deny: []}, allowed: new Set(), sandbox: 'off', backgroundTasks: tasks};
  const start = async (lifetime: 'finite' | 'temporary_service' | 'retained_service', timeout?: number, command = `exec ${sleeper}`) => {
    const result = await tasks.run({root, command, program: '/bin/bash', args: ['-c', command], signal: controller.signal,
      sandbox: ctx.sandbox, background: true, lifetime, requiredByTask: 'User requires this service after completion', timeout,
      access: ctx.sandbox === 'on' ? {network: true} : undefined});
    assert.ok('task' in result);
    pids.push(result.task.pid!);
    return result.task;
  };
  const verify = (id: string, command = 'printf response-verified') => taskHandoff.run({task_id: id, command, description: 'check requested behavior'}, ctx);
  return {root, tasks, events, controller, start, verify, ctx, runtimes};
}

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition not reached');
    await delay(10);
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('offline reproduction: child exit precedes close when a detached descendant inherits output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-pipe-reproduction-'));
  let holder = 0;
  t.after(() => {
    if (holder) try { process.kill(holder, 'SIGKILL'); } catch {}
    fs.rmSync(root, {recursive: true, force: true});
  });
  const child = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync('holder.pid',String(c.pid));c.unref();console.log('shell finished')"], {cwd: root});
  let exited = false;
  let closed = false;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.once('exit', () => { exited = true; });
  const done = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
  await waitFor(() => exited);
  holder = Number(fs.readFileSync(path.join(root, 'holder.pid'), 'utf8'));
  await delay(100);
  assert.equal(child.exitCode, 0);
  assert.equal(closed, false);
  assert.equal(alive(holder), true);
  assert.match(output, /shell finished/);
  process.kill(holder, 'SIGKILL');
  await done;
});

test('normal shell exit settles bounded output capture while preserving collected output and exit status', async (t) => {
  const f = fixture(t);
  let holder = 0;
  t.after(() => { if (holder) try { process.kill(holder, 'SIGKILL'); } catch {} });
  const command = node("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync('holder.pid',String(c.pid));c.unref();console.log('setup complete')");
  const started = performance.now();
  const result = await runCommand({root: f.root, program: '/bin/bash', args: ['-c', command], sandbox: 'off', signal: f.controller.signal, timeoutMs: 5000});
  holder = Number(fs.readFileSync(path.join(f.root, 'holder.pid'), 'utf8'));
  assert.equal(result.code, 0);
  assert.equal(result.outputIncomplete, true);
  assert.equal(result.cleanupUncertain, true);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /setup complete/);
  assert.ok(performance.now() - started < 2500);
  assert.equal(alive(holder), true);
});

test('finite work blocks completion while temporary services are cleaned up without blocking', async (t) => {
  const f = fixture(t);
  const temporary = await f.start('temporary_service');
  assert.equal(f.tasks.hasPending(), false);
  const finite = await f.start('finite', undefined, 'sleep 0.1; printf finite-result');
  assert.equal(f.tasks.hasPending(), true);
  await f.tasks.wait();
  assert.equal(f.tasks.drain()[0]?.id, finite.id);
  assert.equal((await f.tasks.output(finite.id)).output, 'finite-result');
  await f.tasks.close('normal completion', true);
  await waitFor(() => !alive(temporary.pid!));
});

for (const sandbox of ['off', 'on'] as const) {
  test(`verified retained service has independent output and survives normal cleanup with Sandbox ${sandbox}`, {
    skip: sandbox === 'on' && (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) ? 'macOS sandbox required' : false,
  }, async (t) => {
    const f = fixture(t);
    f.ctx.sandbox = sandbox;
    const service = await f.start('retained_service');
    assert.equal(f.tasks.hasPending(), true);
    await waitFor(() => fs.readFileSync(service.logPath, 'utf8').includes('service error'));
    const checked = await f.verify(service.id);
    assert.equal(checked.failure, undefined);
    assert.equal(f.tasks.hasPending(), false);
    const [retained] = await f.tasks.close('normal completion', true);
    assert.equal(retained!.status, 'handed_off');
    assert.equal(alive(service.pid!), true);
    const handoff = retained!.handoff!;
    f.runtimes.push(handoff.runtimePath);
    assert.equal(fs.existsSync(handoff.runtimePath), true);
    assert.match(handoff.stopCommand, new RegExp(`-${service.pid}`));
    assert.equal(JSON.parse(fs.readFileSync(handoff.recordPath, 'utf8')).readiness.output, 'response-verified');
    assert.match((await f.tasks.output(service.id)).output, /service log/);
    await assert.rejects(f.tasks.stop(service.id), /environment-owned/);
    const last = f.events.at(-1);
    assert.equal(last?.type === 'background_task' && last.action, 'handed_off');
  });
}

for (const kind of ['cancel', 'timeout', 'explicit stop', 'failure cleanup'] as const) {
  test(`readiness does not exempt a retained service from ${kind}`, async (t) => {
    const f = fixture(t);
    const service = await f.start('retained_service', kind === 'timeout' ? 150 : undefined);
    await f.verify(service.id);
    if (kind === 'cancel') f.controller.abort();
    if (kind === 'timeout') await waitFor(() => f.events.some((event) => event.type === 'background_task' && event.action === 'completed'));
    if (kind === 'explicit stop') await f.tasks.stop(service.id);
    await f.tasks.close(kind, kind === 'cancel');
    const info = (await f.tasks.output(service.id)).task;
    assert.equal(info.status, kind === 'timeout' ? 'timed_out' : 'stopped');
    assert.equal(info.handoff, undefined);
    await waitFor(() => !alive(service.pid!));
  });
}

test('failed readiness removes earlier eligibility and denies unverified retention', async (t) => {
  const f = fixture(t);
  const service = await f.start('retained_service');
  await f.verify(service.id);
  assert.equal((await f.verify(service.id, 'exit 7')).failure, true);
  assert.equal(f.tasks.hasPending(), true);
  assert.equal(f.tasks.unverifiedServices().length, 1);
  await f.tasks.close('test cleanup');
  assert.equal((await f.tasks.output(service.id)).task.handoff, undefined);
});

test('retention needs an explicit requirement, a live managed service, main ownership, and allowed readiness access', async (t) => {
  const f = fixture(t);
  assert.equal(backgroundBash.schema.safeParse({command: 'true', run_in_background: true, lifetime: 'retained_service'}).success, false);
  const temporary = await f.start('temporary_service');
  await assert.rejects(f.verify(temporary.id), /running retained_service/);
  const child = f.tasks.fork(() => {});
  await assert.rejects(child.run({root: f.root, program: '/bin/bash', args: ['-c', 'sleep 10'], command: 'sleep 10',
    signal: f.controller.signal, background: true, lifetime: 'retained_service', requiredByTask: 'keep available'}), /main agent/);
  const retained = await f.start('retained_service');
  f.ctx.rules.deny.push({tag: 'bash', pattern: '*'});
  const result = await runTool([taskHandoff], 'task_handoff', JSON.stringify({task_id: retained.id, command: 'touch forbidden', description: 'check'}), f.ctx);
  assert.match(result.text, /denied/);
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
  assert.equal((await f.tasks.output(retained.id)).task.readiness, undefined);
});

test('cancellation during slow cleanup keeps verified retained services owned', async (t) => {
  const f = fixture(t);
  let holder = 0;
  t.after(() => { if (holder) try { process.kill(holder, 'SIGKILL'); } catch {} });
  const service = await f.start('retained_service');
  await f.verify(service.id);
  const command = node("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync('holder.pid',String(c.pid));c.unref()");
  await f.start('temporary_service', undefined, command);
  await waitFor(() => fs.existsSync(path.join(f.root, 'holder.pid')));
  holder = Number(fs.readFileSync(path.join(f.root, 'holder.pid'), 'utf8'));
  const closing = f.tasks.close('normal cleanup', true);
  const closed = assert.rejects(closing, /cleanup failed or could not be confirmed/);
  await delay(30);
  assert.equal((await f.tasks.output(service.id)).task.status, 'running');
  assert.equal(f.events.some((event) => event.type === 'background_task' && event.action === 'handed_off'), false);
  f.controller.abort();
  await closed;
  await waitFor(() => !alive(service.pid!));
  assert.equal((await f.tasks.output(service.id)).task.handoff, undefined);
});

test('handoff record failure stops all candidate services before releasing ownership', async (t) => {
  const f = fixture(t);
  const first = await f.start('retained_service');
  const second = await f.start('retained_service');
  await f.verify(first.id);
  await f.verify(second.id);
  fs.rmSync(second.logPath);
  await assert.rejects(f.tasks.close('normal cleanup', true), /service handoff failed/);
  await waitFor(() => !alive(first.pid!) && !alive(second.pid!));
  assert.equal((await f.tasks.output(first.id)).task.handoff, undefined);
  assert.equal(f.events.some((event) => event.type === 'background_task' && event.action === 'handed_off'), false);
});
