import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {after, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {runHeadless, type HeadlessResult} from '../../../core/headless/run.js';
import {jsonLines} from '../../../core/headless/output.js';
import type {AgentEvent, BackgroundTaskInfo} from '../../../core/host.js';
import {loadSettings} from '../../../core/settings.js';
import {fakeModel, finishChunk, streamOf, textChunk, toolCallChunk, usageChunk} from '../../fakes.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-background-headless-'));
const previousHome = process.env.ACC_HOME;
process.env.ACC_HOME = path.join(directory, 'home');
after(() => {
  if (previousHome === undefined) delete process.env.ACC_HOME;
  else process.env.ACC_HOME = previousHome;
  fs.rmSync(directory, {recursive: true, force: true});
});

type Request = {messages: {role: string; content: string; tool_calls?: {id: string}[]; tool_call_id?: string}[]};
const reply = (text: string) => streamOf(textChunk(text), finishChunk('stop'), usageChunk(10, 2));
const calls = (...tools: {name: string; args: unknown}[]) => streamOf(
  ...tools.map((tool, index) => toolCallChunk(`call-${index}`, tool.name, JSON.stringify(tool.args), index)),
  finishChunk('tool_calls'), usageChunk(10, 2),
);
const shell = (command: string, extra = {}) => ({name: 'bash', args: {command, ...extra}});
const notices = (request: Request) => request.messages.filter((message) =>
  message.role === 'user' && message.content.startsWith('[runtime background task completion notice]'));
const lifecycle = (result: HeadlessResult) => result.events.filter((event): event is Extract<AgentEvent, {type: 'background_task'}> =>
  event.type === 'background_task');

function root(t: TestContext) {
  loadSettings([]);
  const work = fs.mkdtempSync(path.join(directory, 'workspace-'));
  t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  return work;
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition not reached within 3 seconds');
    await delay(10);
  }
}

test('another Bash command runs concurrently and completion is delivered after the entire tool batch', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel((nth, body) => {
    if (nth === 1) return calls(
      shell('touch started; while ! test -f release; do sleep 0.01; done; printf A-done; touch finished', {run_in_background: true}),
      shell('while ! test -f started; do sleep 0.01; done; test ! -f finished || exit 9; touch overlapped release; while ! test -f finished; do sleep 0.01; done; sleep 0.03; printf B-done'),
    );
    const request = body as Request;
    assert.equal(fs.existsSync(path.join(work, 'overlapped')), true);
    assert.equal(notices(request).length, 1);
    const assistantIndex = request.messages.findIndex((message) => message.tool_calls?.length === 2);
    assert.deepEqual(request.messages.slice(assistantIndex + 1, assistantIndex + 3).map((message) => message.tool_call_id), ['call-0', 'call-1']);
    return reply('Verified both commands.');
  });
  const result = await runHeadless({root: work, task: 'overlap commands', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'done');
  assert.equal(count(), 2);
  assert.deepEqual(lifecycle(result).map((event) => event.action), ['started', 'completed']);
  assert.deepEqual(result.usage, {prompt: 20, completion: 4, total: 24});
});

test('a completion after a reply resumes the agent once and exposes failed output through task_output', async (t) => {
  const work = root(t);
  let id = '';
  const {choice, calls: count} = fakeModel((nth, body) => {
    if (nth === 1) return calls(shell('while ! test -f release; do sleep 0.01; done; printf failed-test; exit 7', {run_in_background: true}));
    if (nth === 2) {
      setTimeout(() => fs.writeFileSync(path.join(work, 'release'), ''), 50);
      return reply('Other work is complete.');
    }
    const request = body as Request;
    if (nth === 3) {
      const notice = notices(request);
      assert.equal(notice.length, 1);
      const info = JSON.parse(notice[0]!.content.split('\n')[1]!) as BackgroundTaskInfo;
      id = info.id;
      assert.equal(info.status, 'failed');
      assert.equal(info.code, 7);
      return calls({name: 'task_output', args: {task_id: id, offset: 0, limit: 6}});
    }
    assert.equal(nth, 4);
    const output = JSON.parse(request.messages.filter((message) => message.role === 'tool').at(-1)!.content);
    assert.equal(output.task.id, id);
    assert.equal(output.task.code, 7);
    assert.equal(output.output, 'failed');
    assert.equal(output.next_offset, 6);
    return reply('The test failed with exit 7.');
  });
  const result = await runHeadless({root: work, task: 'check test results', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'done');
  assert.equal(count(), 4);
  assert.equal(result.text, 'Other work is complete.The test failed with exit 7.');
  assert.equal(result.events.filter((event) => event.type === 'turn_end').length, 1);
  assert.deepEqual(result.usage, {prompt: 40, completion: 8, total: 48});
  assert.equal(result.tokenUsage.requests.length, 4);
  assert.equal(result.tokenUsage.totals.totalTokens, 48);
  const log = lifecycle(result)[0]!.task.logPath;
  assert.equal(fs.readFileSync(log, 'utf8'), 'failed-test');
  assert.equal(log.startsWith(path.join(process.env.ACC_HOME!, 'runs')), true);
  const final = JSON.parse(jsonLines(result).at(-1)!);
  assert.equal(final.schemaVersion, 2);
  assert.equal(final.message, result.text);
});

test('foreground timeout backgrounds the same command and completion resumes within the same budget', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel((nth, body) => {
    if (nth === 1) return calls(shell('echo $$ >> executions; while ! test -f release; do sleep 0.01; done; printf done', {timeout: 10}));
    if (nth === 2) {
      const output = (body as Request).messages.filter((message) => message.role === 'tool').at(-1);
      assert.match(output!.content, /moved to the background/);
      setTimeout(() => fs.writeFileSync(path.join(work, 'release'), ''), 30);
      return reply('Waiting for the command.');
    }
    assert.equal(notices(body as Request).length, 1);
    return reply('Command verified.');
  });
  const result = await runHeadless({root: work, task: 'long command', choice, policy: 'yes', maxSeconds: 5, maxSteps: 3});
  assert.equal(result.stopped, 'done');
  assert.equal(count(), 3);
  assert.equal(fs.readFileSync(path.join(work, 'executions'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(result.events.filter((event) => event.type === 'model_request_start').map((event) => event.request), [1, 2, 3]);
});

test('step exhaustion stops pending commands immediately instead of waiting or resetting the budget', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel((nth) => nth === 1
    ? calls(shell('sleep 20', {run_in_background: true})) : reply('Pending.'));
  const start = performance.now();
  const result = await runHeadless({root: work, task: 'budget', choice, policy: 'yes', maxSeconds: 10, maxSteps: 2});
  assert.equal(result.stopped, 'step_limit');
  assert.equal(count(), 2);
  assert.ok(performance.now() - start < 3000);
  const completed = lifecycle(result).filter((event) => event.action === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.task.status, 'stopped');
  assert.deepEqual(result.usage, {prompt: 20, completion: 4, total: 24});
});

test('overall deadline stops an idle background wait and preserves usage already spent', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel((nth) => nth === 1
    ? calls(shell('sleep 20', {run_in_background: true})) : reply('Pending.'));
  const result = await runHeadless({root: work, task: 'deadline', choice, policy: 'yes', maxSeconds: 0.2});
  assert.equal(result.stopped, 'timeout');
  assert.equal(count(), 2);
  assert.equal(lifecycle(result).at(-1)!.task.status, 'stopped');
  assert.deepEqual(result.usage, {prompt: 20, completion: 4, total: 24});
});

test('external cancellation stops process groups and does not wake the agent again', async (t) => {
  const work = root(t);
  const controller = new AbortController();
  const {choice, calls: count} = fakeModel((nth) => {
    if (nth === 1) return calls(shell('echo $$ > shell.pid; sleep 20 & echo $! > child.pid; wait', {run_in_background: true}));
    setTimeout(() => controller.abort(), 50);
    return reply('Pending.');
  });
  const result = await runHeadless({root: work, task: 'cancel', choice, policy: 'yes', maxSeconds: 5, signal: controller.signal});
  assert.equal(result.stopped, 'cancelled');
  assert.match(result.error!, /interrupted/);
  assert.equal(count(), 2);
  for (const file of ['shell.pid', 'child.pid']) {
    const pid = Number(fs.readFileSync(path.join(work, file), 'utf8'));
    await waitFor(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    });
  }
  assert.equal(lifecycle(result).filter((event) => event.action === 'completed').length, 1);
});

test('simultaneous completions are each delivered once without idle model polling', async (t) => {
  const work = root(t);
  let delivered: string[] = [];
  const {choice, calls: count} = fakeModel((nth, body) => {
    if (nth === 1) return calls(...[1, 2].map((n) => shell(`while ! test -f release; do sleep 0.01; done; printf task-${n}`, {run_in_background: true})));
    if (nth === 2) {
      setTimeout(() => fs.writeFileSync(path.join(work, 'release'), ''), 30);
      return reply('Waiting.');
    }
    delivered = notices(body as Request).flatMap((notice) => notice.content.split('\n').slice(1, -1)
      .map((line) => (JSON.parse(line) as BackgroundTaskInfo).id));
    return reply('Reviewed.');
  });
  const result = await runHeadless({root: work, task: 'two commands', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'done');
  assert.equal(new Set(delivered).size, 2);
  assert.equal(delivered.length, 2);
  assert.ok(count() >= 3 && count() <= 4);
  assert.equal(lifecycle(result).filter((event) => event.action === 'completed').length, 2);
});

test('subagent shells are stopped and reported when their owner finishes', async (t) => {
  const work = root(t);
  const {choice} = fakeModel((nth, body) => {
    if (nth === 1) return calls({name: 'agent', args: {description: 'Run child command', prompt: 'start a background command'}});
    if (nth === 2) return calls(shell('sleep 20', {run_in_background: true}));
    if (nth === 3) return reply('Child finished.');
    const result = (body as Request).messages.filter((message) => message.role === 'tool').at(-1)!;
    assert.match(result.content, /Background commands stopped when this subagent finished/);
    assert.match(result.content, /owning subagent finished/);
    assert.equal(notices(body as Request).length, 0);
    return reply('Reviewed child cleanup.');
  });
  const result = await runHeadless({root: work, task: 'use subagent', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'done');
  assert.equal(lifecycle(result).at(-1)!.task.status, 'stopped');
  assert.deepEqual(result.usage, {prompt: 40, completion: 8, total: 48});
  assert.equal(result.tokenUsage.totals.totalTokens, 48);
});

test('a fatal model failure stops live tasks without treating their cleanup as a new prompt', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel((nth) => {
    if (nth === 1) return calls(shell('sleep 20', {run_in_background: true}));
    return new Error('scripted fatal failure');
  });
  const result = await runHeadless({root: work, task: 'fail', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'error');
  assert.equal(count(), 2);
  assert.equal(lifecycle(result).at(-1)!.task.status, 'stopped');
});

test('permission refusal prevents background startup', async (t) => {
  const work = root(t);
  fs.writeFileSync(path.join(work, 'victim'), 'keep');
  const {choice} = fakeModel((nth) => nth === 1
    ? calls(shell('rm victim', {run_in_background: true})) : reply('Permission refused.'));
  const result = await runHeadless({root: work, task: 'remove a file', choice, policy: 'deny', maxSeconds: 5});
  assert.equal(result.stopped, 'denied');
  assert.deepEqual(lifecycle(result), []);
  assert.equal(fs.readFileSync(path.join(work, 'victim'), 'utf8'), 'keep');
});

test('the agent can stop a long-lived command through task_stop and finish normally', async (t) => {
  const work = root(t);
  const {choice, calls: count} = fakeModel(async (nth, body) => {
    if (nth === 1) return calls(shell('touch started; sleep 20', {run_in_background: true}));
    const request = body as Request;
    if (nth === 2) {
      await waitFor(() => fs.existsSync(path.join(work, 'started')));
      const launch = request.messages.filter((message) => message.role === 'tool').at(-1)!.content;
      const info = JSON.parse(launch.split('\n')[1]!) as BackgroundTaskInfo;
      return calls({name: 'task_stop', args: {task_id: info.id}});
    }
    assert.equal(nth, 3);
    const stopped = JSON.parse(request.messages.filter((message) => message.role === 'tool').at(-1)!.content) as BackgroundTaskInfo;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.reason, 'stopped by the agent');
    assert.equal(notices(request).length, 1);
    return reply('Stopped the server.');
  });
  const result = await runHeadless({root: work, task: 'start and stop a server', choice, policy: 'yes', maxSeconds: 5});
  assert.equal(result.stopped, 'done');
  assert.equal(count(), 3);
  assert.equal(result.text, 'Stopped the server.');
});
