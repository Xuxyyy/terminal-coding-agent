import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {render} from 'ink';
import {listSessions} from '../../core/projects.js';
import {loadSession} from '../../core/store.js';
import {useAgent, type Agent} from '../../ui/agent.js';
import type {
  ContextItem,
  Item,
  NoticeItem,
  TaskItem,
  TextItem,
} from '../../ui/events.js';
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
    ['user', 'assistant'],
  );
});

test('starting the repl and quitting leaves no session behind', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  await tick();
  agent.current!.shutdown();
  await tick();
  unmount();

  assert.deepEqual(listSessions(root, home), []);
});

test('clearing leaves no empty session behind either', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.clear();
  await tick();
  unmount();

  assert.equal(listSessions(root, home).length, 1);
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
  assert.match((items[1] as NoticeItem).text, /^restored 2 messages/);
  assert.equal((items[2] as TaskItem).text, 'fix the cart');
  assert.equal((items[3] as TextItem).text, 'done');

  two.agent.current!.send('and the total');
  await settle(two.agent);
  two.unmount();

  const again = loadSession(root, older!.id, home);
  assert.deepEqual(
    again.messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(again.meta.id, older!.id);
});

function lastContext(items: Item[]): ContextItem {
  const last = items[items.length - 1];
  assert.equal(last!.kind, 'context');
  return last as ContextItem;
}

test('resuming restores the context reading of the last turn', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const first = fakeModel(() => answer('done'));
  const one = mount(root, first.choice);
  one.agent.current!.send('fix the cart');
  await settle(one.agent);
  one.agent.current!.send('and the readme');
  await settle(one.agent);
  one.unmount();
  const [older] = listSessions(root, home);

  const second = fakeModel(() => answer('still here'));
  const two = mount(root, second.choice);
  two.agent.current!.pick();
  await tick();
  two.agent.current!.resume(older!.id);
  await tick();
  two.agent.current!.context();
  await tick();
  two.unmount();

  const stored = loadSession(root, older!.id, home);
  assert.equal(stored.meta.usage.total, 30);
  assert.equal(stored.lastUsage!.total, 15);
  assert.equal(lastContext(two.agent.current!.committed).used, 15);
});

test('a rewind after a resume forgets the measured reading', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const first = fakeModel(() => answer('done'));
  const one = mount(root, first.choice);
  one.agent.current!.send('fix the cart');
  await settle(one.agent);
  one.agent.current!.send('and the readme');
  await settle(one.agent);
  one.unmount();
  const [older] = listSessions(root, home);

  const second = fakeModel(() => answer('still here'));
  const two = mount(root, second.choice);
  two.agent.current!.pick();
  await tick();
  two.agent.current!.resume(older!.id);
  await tick();
  const rows = two.agent.current!.checkpoints();
  two.agent.current!.pickRewind();
  await tick();
  two.agent.current!.rewind(rows[1]!.id);
  await tick();
  two.agent.current!.context();
  await tick();
  two.unmount();

  assert.deepEqual(
    rows.map((row) => row.title),
    ['fix the cart', 'and the readme'],
  );
  const status = lastContext(two.agent.current!.committed);
  assert.equal(status.measured, false);
  assert.equal(
    status.system! + status.tools! + status.conversation!,
    status.used,
  );
  assert.ok(status.used > 0, `expected the prompt to still cost, got ${status.used}`);
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

test('cancelling the picker changes nothing', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  const before = agent.current!.committed;
  agent.current!.pickRewind();
  await tick();
  assert.equal(agent.current!.phase.kind, 'rewinding');
  agent.current!.cancelPick();
  await tick();
  unmount();

  assert.equal(agent.current!.phase.kind, 'idle');
  assert.deepEqual(agent.current!.committed, before);
  assert.deepEqual(
    loadSession(root, null, home).messages.map((message) => message.content),
    ['fix the cart', 'done'],
  );
});

test('a rewind cuts the screen, the messages and the file together', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel(() => answer('done'));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.send('and the readme');
  await settle(agent);

  const rows = agent.current!.checkpoints();
  assert.deepEqual(
    rows.map((row) => row.title),
    ['fix the cart', 'and the readme'],
  );
  agent.current!.pickRewind();
  await tick();
  agent.current!.rewind(rows[1]!.id);
  await tick();
  unmount();

  const items = agent.current!.committed;
  assert.deepEqual(
    items.map((item) => (item.kind === 'task' ? item.text : item.kind)),
    ['notice', 'fix the cart', 'text'],
  );
  assert.match((items[0] as NoticeItem).text, /rewound to before "and the readme"/);
  const stored = loadSession(root, null, home);
  assert.deepEqual(
    stored.messages.map((message) => message.content),
    ['fix the cart', 'done'],
  );
  assert.equal(JSON.stringify(stored.view).includes('and the readme'), false);
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
    ['user', 'assistant'],
  );
  assert.equal(JSON.stringify(newest.messages).includes('fix the cart'), false);
});
