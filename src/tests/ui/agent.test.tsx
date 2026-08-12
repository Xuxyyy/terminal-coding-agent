import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {render} from 'ink';
import {listSessions, loadSession} from '../../core/store.js';
import {useAgent, type Agent} from '../../ui/agent.js';
import type {NoticeItem, TaskItem, TextItem} from '../../ui/events.js';
import {fakeModel, finishChunk, streamOf, textChunk, usageChunk} from '../fakes.js';

type Ref = {current: Agent | null};

const stdout = {
  columns: 200,
  rows: 40,
  isTTY: true,
  write() {},
  on() {},
  off() {},
  removeListener() {},
} as unknown as NodeJS.WriteStream;

function answer(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(10, 5));
}

function mount(
  root: string,
  choice: ReturnType<typeof fakeModel>['choice'],
): {agent: Ref; unmount: () => void} {
  const agent: Ref = {current: null};
  function Probe() {
    agent.current = useAgent(root, choice);
    return null;
  }
  const instance = render(<Probe />, {
    stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {agent, unmount: () => instance.unmount()};
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function settle(agent: Ref): Promise<void> {
  for (let n = 0; n < 2_000; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (agent.current?.phase.kind === 'idle') return;
  }
  assert.fail('the agent never went back to idle');
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-agent-'));
  process.env.ACC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-store-'));
  return root;
}

test('the repl writes every turn to a session on disk', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  assert.equal(agent.current!.send('fix the cart'), true);
  await settle(agent);
  unmount();

  const [meta] = listSessions(root, home);
  assert.ok(meta, 'expected one stored session');
  assert.equal(meta.workspace, root);
  assert.equal(meta.usage.total, 15);
  const stored = loadSession(root, null, home);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['system', 'user', 'assistant'],
  );
});

test('resuming replays the old screen and writes back to the same session', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const first = fakeModel(() => answer('done'));
  const one = mount(root, first.choice);
  one.agent.current!.send('fix the cart');
  await settle(one.agent);
  one.unmount();
  const [older] = listSessions(root, home);

  const second = fakeModel(() => answer('still here'));
  const two = mount(root, second.choice);
  two.agent.current!.pick();
  await tick();
  assert.equal(two.agent.current!.phase.kind, 'picking');
  two.agent.current!.resume(older!.id);
  await tick();

  const items = two.agent.current!.committed;
  assert.equal(items[0]!.kind, 'header');
  assert.equal(items[1]!.kind, 'notice');
  assert.match((items[1] as NoticeItem).text, /^restored 3 messages/);
  assert.equal((items[2] as TaskItem).text, 'fix the cart');
  assert.equal((items[3] as TextItem).text, 'done');

  two.agent.current!.send('and the total');
  await settle(two.agent);
  two.unmount();

  const again = loadSession(root, older!.id, home);
  assert.deepEqual(
    again.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(again.meta.id, older!.id);
});

test('cancelling the picker leaves the conversation alone', async () => {
  const root = workspace();
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  const before = agent.current!.committed;
  agent.current!.pick();
  await tick();
  agent.current!.cancelPick();
  await tick();

  assert.equal(agent.current!.phase.kind, 'idle');
  assert.deepEqual(agent.current!.committed, before);
  unmount();
});

test('clearing the repl starts a session that forgets the old one', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.clear();
  agent.current!.send('something else');
  await settle(agent);
  unmount();

  assert.equal(listSessions(root, home).length, 2);
  const newest = loadSession(root, null, home);
  assert.deepEqual(
    newest.messages.map((message) => message.role),
    ['system', 'user', 'assistant'],
  );
  assert.equal(JSON.stringify(newest.messages).includes('fix the cart'), false);
});
