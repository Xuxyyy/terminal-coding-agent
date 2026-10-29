import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import {AgentRuntime} from '../../core/agent-runtime.js';
import {BackgroundTasks} from '../../core/background.js';
import {runAgent} from '../../core/loop.js';
import {createSession} from '../../core/session.js';
import {fakeHost, fakeModel, finishChunk, streamOf, textChunk} from '../fakes.js';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-loop-wait-'));
  const {host, controller} = fakeHost();
  const tasks = new BackgroundTasks({signal: host.signal, onEvent() {}, directory: path.join(root, 'tasks')});
  const agents = new AgentRuntime(host);
  const command = 'while ! test -f release; do sleep 0.01; done';
  await tasks.run({root, command, program: '/bin/bash', args: ['-c', command], signal: host.signal, sandbox: 'off', background: true});
  t.after(async () => {
    controller.abort();
    await agents.close();
    await tasks.close('test cleanup');
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, host, controller, tasks, agents};
}

const reply = () => streamOf(textChunk('Waiting.'), finishChunk('stop'));

test('automatic main wait receives mail sent between its pending check and subscription', async (t) => {
  const f = await fixture(t);
  const subscribe = f.agents.subscribe.bind(f.agents);
  let sent = false;
  f.agents.subscribe = (listener) => {
    if (!sent) {
      sent = true;
      f.agents.send('idle-child', 'main', 'finding during subscription');
    }
    return subscribe(listener);
  };
  const model = fakeModel((nth, body) => {
    if (nth === 2) {
      assert.match(JSON.stringify(body), /finding during subscription/);
      assert.equal(f.tasks.hasPending(), true);
      fs.writeFileSync(path.join(f.root, 'release'), '');
    }
    assert.ok(nth <= 3, 'main made an extra model request without a new event');
    return reply();
  });
  await runAgent(createSession(f.root, 'main', 1_000_000), model.choice, f.host, [], undefined,
    {agents: f.agents, backgroundTasks: f.tasks, waitForBackground: true});
  assert.equal(model.calls(), 3);
});

test('cancelling automatic main wait removes shell and child subscriptions without model polling', async (t) => {
  const f = await fixture(t);
  f.agents.start('child', 'active child', async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {once: true}));
    return {text: 'interrupted'};
  }, true, 'assignment');
  let subscribed = 0;
  let unsubscribed = 0;
  let resolveSubscribed!: () => void;
  const bothSubscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve; });
  for (const manager of [f.tasks, f.agents]) {
    const subscribe = manager.subscribe.bind(manager);
    manager.subscribe = (listener) => {
      const unsubscribe = subscribe(listener);
      if (++subscribed === 2) resolveSubscribed();
      return () => { unsubscribed++; unsubscribe(); };
    };
  }
  const model = fakeModel(() => reply());
  const pending = runAgent(createSession(f.root, 'main', 1_000_000), model.choice, f.host, [], undefined,
    {agents: f.agents, backgroundTasks: f.tasks, waitForBackground: true});
  await bothSubscribed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(model.calls(), 1);
  assert.equal(unsubscribed, 0);
  f.controller.abort();
  await pending;
  assert.equal(unsubscribed, 2);
  assert.equal(model.calls(), 1);
});

test('a child waiting for its shell wakes for its own inbox without consuming main mail', async (t) => {
  const f = await fixture(t);
  f.agents.send('child', 'main', 'main-only update');
  let wake!: () => void;
  const waiting = new Promise<void>((resolve) => { wake = resolve; });
  const model = fakeModel((nth, body) => {
    if (nth === 2) {
      assert.match(JSON.stringify(body), /child-only instruction/);
      assert.doesNotMatch(JSON.stringify(body), /main-only update/);
      assert.equal(f.tasks.hasPending(), true);
      fs.writeFileSync(path.join(f.root, 'release'), '');
    }
    assert.ok(nth <= 3);
    return reply();
  });
  const pending = runAgent(createSession(f.root, 'child', 1_000_000), model.choice, f.host, [], undefined,
    {agents: f.agents, inboxId: 'child', backgroundTasks: f.tasks, onWait: (active) => { if (active) wake(); }});
  await waiting;
  assert.equal(model.calls(), 1);
  f.agents.send('main', 'child', 'child-only instruction');
  await pending;
  assert.equal(model.calls(), 3);
  assert.equal(f.agents.mail.pending('main').length, 1);
});
