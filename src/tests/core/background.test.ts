import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type TestContext} from 'node:test';
import {BackgroundTasks} from '../../core/background.js';
import type {AgentEvent} from '../../core/host.js';
import {OUTPUT_LIMIT, runCommand} from '../../core/sandbox/run.js';
import {backgroundBash} from '../../core/tools/bash.js';
import {taskOutput, taskStop} from '../../core/tools/tasks.js';
import {toolsFor, toolDefinitions} from '../../core/tools/index.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';
import {fakeHost} from '../fakes.js';
import {childTools} from '../../core/tools/subagent.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-background-test-'));
  const events: AgentEvent[] = [];
  const {host, controller, asked} = fakeHost();
  const tasks = new BackgroundTasks({signal: controller.signal, onEvent: (event) => events.push(event),
    directory: path.join(root, 'private', 'tasks')});
  t.after(async () => {
    await tasks.close('test cleanup');
    fs.rmSync(root, {recursive: true, force: true});
  });
  const ctx: ToolContext = {root, host, allowed: new Set(), rules: {allow: [], ask: [], deny: []},
    mode: 'auto-edits', sandbox: 'off', backgroundTasks: tasks};
  const run = (command: string, background = true, timeout?: number) => tasks.run({root, command,
    program: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], signal: controller.signal,
    sandbox: 'off', background, timeout});
  return {root, tasks, events, host, controller, ctx, asked, run};
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not become true within 3 seconds');
    await delay(10);
  }
}

async function gone(pid: number) {
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  });
}

test('a background shell overlaps another command and preserves private logs after cleanup', async (t) => {
  const f = fixture(t);
  const running = await f.run('echo $$ > first.pid; echo "$HOME" > home.path; printf started; while ! test -f release; do sleep 0.01; done; printf finished');
  assert.ok('task' in running);
  await waitFor(() => fs.readFileSync(running.task.logPath, 'utf8') === 'started');
  const page = await f.tasks.output(running.task.id);
  assert.equal(page.task.status, 'running');
  assert.equal(page.output, 'started');
  assert.equal(page.task.characters, 7);
  const second = await f.run('test -f first.pid && touch release && printf second', false);
  assert.ok('result' in second);
  assert.equal(second.result.stdout, 'second');
  await f.tasks.wait();
  const [notice] = f.tasks.drain();
  assert.equal(notice?.status, 'completed');
  assert.deepEqual(f.tasks.drain(), []);
  const temporary = fs.readFileSync(path.join(f.root, 'home.path'), 'utf8').trim();
  assert.equal(fs.existsSync(temporary), false);
  await f.tasks.close('done');
  assert.equal(fs.readFileSync(running.task.logPath, 'utf8'), 'startedfinished');
  assert.equal(fs.statSync(running.task.logPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(running.task.logPath)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(fs.readFileSync(running.task.logPath.replace(/\.log$/, '.json'), 'utf8')).status, 'completed');
  assert.deepEqual(f.events.map((event) => event.type === 'background_task' ? event.action : event.type), ['started', 'completed']);
});

test('foreground expiry moves the original process into the background exactly once', async (t) => {
  const f = fixture(t);
  const result = await f.run('echo $$ >> executions; sleep 0.1; printf done', false, 10);
  assert.ok('task' in result);
  assert.equal(result.moved, true);
  await f.tasks.wait();
  assert.equal(f.tasks.drain()[0]?.status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.root, 'executions'), 'utf8').trim().split('\n').length, 1);
  assert.equal((await f.tasks.output(result.task.id)).output, 'done');
});

test('output pages use character offsets and work during and after execution', async (t) => {
  const f = fixture(t);
  const text = 'α😀z'.repeat(15_000);
  const result = await f.run(node(`process.stdout.write(${JSON.stringify(text)});`));
  assert.ok('task' in result);
  await f.tasks.wait();
  const first = await f.tasks.output(result.task.id);
  assert.equal(first.output, text.slice(0, 30_000));
  assert.equal(first.next_offset, 30_000);
  const next = await f.tasks.output(result.task.id, first.next_offset, 9000);
  assert.equal(next.output, text.slice(30_000, 39_000));
  assert.equal((await f.tasks.output(result.task.id, text.length + 100)).output, '');
  for (const [offset, limit] of [[-1, 1], [0, 30_001], [1.5, 1], [0, 0]]) {
    await assert.rejects(f.tasks.output(result.task.id, offset, limit), /offset must/);
  }
});

test('UTF-8 characters split across process writes are decoded without corruption', async (t) => {
  const f = fixture(t);
  const result = await f.run(node("const b=Buffer.from('A😀B');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),20);"), false);
  assert.ok('result' in result);
  assert.equal(result.result.stdout, 'A😀B');
});

test('failures, explicit stops, and background runtime expiry retain their exit reasons', async (t) => {
  const f = fixture(t);
  const failed = await f.run('printf bad >&2; exit 7');
  assert.ok('task' in failed);
  await f.tasks.wait();
  assert.equal(f.tasks.drain()[0]?.code, 7);
  assert.equal((await f.tasks.output(failed.task.id)).task.status, 'failed');
  const stopped = await f.run('sleep 20');
  assert.ok('task' in stopped);
  const status = await f.tasks.stop(stopped.task.id);
  assert.equal(status.status, 'stopped');
  assert.equal(status.reason, 'stopped by the agent');
  assert.equal((await f.tasks.stop(stopped.task.id)).status, 'stopped');
  f.tasks.drain();
  const expired = await f.run('sleep 20', true, 20);
  assert.ok('task' in expired);
  await f.tasks.wait();
  const [notice] = f.tasks.drain();
  assert.equal(notice?.status, 'timed_out');
  assert.equal(notice?.code, 124);
  assert.match(notice!.reason!, /runtime limit/);
});

test('32 MiB is a combined output limit and its failure is saved', async (t) => {
  const f = fixture(t);
  const result = await f.run(node(`process.stdout.write(Buffer.alloc(${OUTPUT_LIMIT / 2},120),()=>process.stderr.write(Buffer.alloc(${OUTPUT_LIMIT / 2 + 1},121)));`));
  assert.ok('task' in result);
  await f.tasks.wait();
  const [notice] = f.tasks.drain();
  assert.equal(notice?.status, 'output_limit');
  assert.match(notice!.reason!, /32 MiB/);
  assert.ok(fs.statSync(result.task.logPath).size <= OUTPUT_LIMIT);
});

test('task ownership blocks parent, sibling, unknown IDs, and path traversal', async (t) => {
  const f = fixture(t);
  const child = f.tasks.fork(() => {});
  const sibling = f.tasks.fork(() => {});
  const result = await f.run('sleep 20');
  assert.ok('task' in result);
  for (const manager of [child, sibling]) {
    await assert.rejects(manager.output(result.task.id), /unknown task/);
    await assert.rejects(manager.stop(result.task.id), /unknown task/);
  }
  await assert.rejects(f.tasks.output('../../settings.json'), /unknown task/);
  const owned = await child.run({root: f.root, command: 'sleep 20', program: '/bin/bash', args: ['-c', 'sleep 20'],
    signal: f.controller.signal, sandbox: 'off', background: true});
  assert.ok('task' in owned);
  await assert.rejects(f.tasks.stop(owned.task.id), /unknown task/);
  assert.equal((await child.close('owning subagent finished'))[0]?.reason, 'owning subagent finished');
  assert.deepEqual(f.tasks.drain(), []);
});

test('closing kills shell descendants and cleans startup races without late notices', async (t) => {
  const f = fixture(t);
  const result = await f.run('sleep 20 & echo $! > child.pid; wait');
  assert.ok('task' in result);
  await waitFor(() => fs.existsSync(path.join(f.root, 'child.pid')));
  const pid = Number(fs.readFileSync(path.join(f.root, 'child.pid'), 'utf8'));
  await f.tasks.close('budget exhausted');
  await gone(pid);
  assert.deepEqual(f.tasks.drain(), []);
  await assert.rejects(f.run('touch forbidden'), /interrupted/);
  const other = new BackgroundTasks({signal: f.controller.signal, onEvent() {}, directory: path.join(f.root, 'racing')});
  const starting = other.run({root: f.root, command: 'sleep 20', program: '/bin/bash', args: ['-c', 'sleep 20'],
    signal: f.controller.signal, sandbox: 'off', background: true});
  const rejected = assert.rejects(starting, /interrupted|startup/);
  await other.close('shutdown');
  await rejected;
  assert.deepEqual(other.drain(), []);
});

test('invalid background arguments and denied commands never start a process', async (t) => {
  const f = fixture(t);
  const registry = [backgroundBash, taskOutput, taskStop];
  for (const args of [{command: 'touch forbidden', timeout: 600_001},
    {command: 'touch forbidden', run_in_background: true, timeout: 7_200_001},
    {command: 'touch forbidden', timeout: 0}]) {
    assert.match((await runTool(registry, 'bash', JSON.stringify(args), f.ctx)).text, /invalid arguments/);
  }
  f.ctx.rules.deny.push({tag: 'bash', pattern: '*'});
  assert.match((await runTool(registry, 'bash', JSON.stringify({command: 'touch forbidden', run_in_background: true}), f.ctx)).text, /denied/);
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
  assert.deepEqual(f.events, []);
  assert.equal(fs.existsSync(f.tasks.directory), false);
});

test('interactive tool definitions keep their original Bash interface', () => {
  for (const mode of ['auto', 'auto-edits', 'ask-edits'] as const) {
    const interactive = toolsFor(mode);
    assert.equal(interactive.some((tool) => tool.name === 'task_output' || tool.name === 'task_stop'), false);
    const schema = interactive.find((tool) => tool.name === 'bash')!.schema.parse({command: 'true', run_in_background: true, timeout: 1});
    assert.deepEqual(schema, {command: 'true'});
    assert.deepEqual(toolsFor(mode, true).filter((tool) => tool.name.startsWith('task_')).map((tool) => tool.name), ['task_output', 'task_stop']);
  }
});

test('headless tool schemas use numeric JSON Schema exclusive bounds accepted by the provider', () => {
  const check = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
        assert.equal(typeof nested, 'number', `${key} must be numeric in the provider tool schema`);
      }
      check(nested);
    }
  };
  for (const mode of ['auto', 'auto-edits', 'ask-edits'] as const) {
    check(toolDefinitions(toolsFor(mode, true)));
  }
  assert.equal(backgroundBash.schema.safeParse({command: 'true', timeout: 0}).success, false);
  assert.equal(backgroundBash.schema.safeParse({command: 'true', timeout: 1}).success, true);
});

test('the original command runner still kills commands at its timeout', async (t) => {
  const f = fixture(t);
  const result = await runCommand({root: f.root, program: '/bin/bash', args: ['-c', 'sleep 20'],
    signal: f.controller.signal, sandbox: 'off', timeoutMs: 20});
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
});

test('startup errors report failure without a false background-start event', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.tasks.run({root: f.root, command: 'missing', program: '/does-not-exist-acc-test', args: [],
    signal: f.controller.signal, sandbox: 'off', background: true}), /could not start/);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.tasks.drain(), []);
});

test('headless subagent allowlists keep exactly their permitted tools', () => {
  assert.deepEqual(childTools('auto-edits', ['bash'], true).map((tool) => tool.name), ['bash']);
  assert.deepEqual(childTools('auto', ['read_file', 'task_output'], true).map((tool) => tool.name), ['task_output']);
  assert.deepEqual(childTools('auto-edits', [], true), []);
});

test('background commands preserve sandbox restrictions and use only approved extra access', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') ? 'native macOS sandbox required' : false,
}, async (t) => {
  const f = fixture(t);
  f.ctx.sandbox = 'on';
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-background-outside-'));
  t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
  const target = path.join(outside, 'public.txt');
  fs.writeFileSync(target, 'allowed-read');
  const command = node(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(target)},'utf8'));`);
  const registry = [backgroundBash];
  await runTool(registry, 'bash', JSON.stringify({command, run_in_background: true}), f.ctx);
  await f.tasks.wait();
  const [blocked] = f.tasks.drain();
  assert.equal(blocked?.status, 'failed');
  assert.match((await f.tasks.output(blocked!.id)).output, /EPERM|EACCES/);
  await runTool(registry, 'bash', JSON.stringify({command, run_in_background: true, access: {read_paths: [target]}}), f.ctx);
  await f.tasks.wait();
  const [allowed] = f.tasks.drain();
  assert.equal(allowed?.status, 'completed');
  assert.equal((await f.tasks.output(allowed!.id)).output, 'allowed-read');
  assert.match(f.asked.at(-1)!.reason, /Extra sandbox access/);
  await runTool(registry, 'bash', JSON.stringify({command, run_in_background: true}), f.ctx);
  await f.tasks.wait();
  assert.equal(f.tasks.drain()[0]?.status, 'failed');
});
