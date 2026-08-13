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
import {
  fakeModel,
  finishChunk,
  statusError,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';

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

const SUMMARY = 'the cart was fixed in cart.ts';

function summaryOf(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(400, 20));
}

function summarizingModel(): ReturnType<typeof fakeModel> {
  return fakeModel((turn) => (turn === 2 ? summaryOf(SUMMARY) : answer('done')));
}

function occurrences(messages: unknown, needle: string): number {
  return JSON.stringify(messages).split(needle).length - 1;
}

test('/compact on an idle session replaces the conversation and commits only a notice', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = summarizingModel();
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.compact();
  await settle(agent);
  unmount();

  const items = agent.current!.committed;
  const notice = items[items.length - 1]!;
  assert.equal(notice.kind, 'notice');
  assert.match(
    (notice as NoticeItem).text,
    /^↯ compacted \d+ messages?, ~[\d,]+ tokens freed$/,
  );
  assert.equal(
    items.some((item) => item.kind === 'context'),
    false,
  );
  const stored = loadSession(root, null, home);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['assistant'],
  );
  assert.match(String(stored.messages[0]!.content), /the cart was fixed in cart\.ts/);
  assert.equal(JSON.stringify(stored.messages).includes('fix the cart'), false);
});

test('/compact while the agent is busy does nothing', async () => {
  const root = workspace();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const {choice, calls} = fakeModel(() => ({
    async *[Symbol.asyncIterator]() {
      await held;
      yield textChunk('done');
      yield finishChunk('stop');
      yield usageChunk(10, 5);
    },
  }));
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await tick();
  assert.equal(agent.current!.phase.kind, 'busy');
  const before = agent.current!.committed;
  agent.current!.compact();
  await tick();

  assert.equal(agent.current!.phase.kind, 'busy');
  assert.deepEqual(agent.current!.committed, before);
  assert.equal(calls(), 1);
  release();
  await settle(agent);
  unmount();
});

test('the spinner says compacting while the summary is in flight', async () => {
  const root = workspace();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const {choice} = fakeModel((turn) =>
    turn === 1
      ? answer('done')
      : {
          async *[Symbol.asyncIterator]() {
            await held;
            yield textChunk(SUMMARY);
            yield finishChunk('stop');
            yield usageChunk(400, 20);
          },
        },
  );
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.compact();
  await tick();

  const phase = agent.current!.phase;
  assert.equal(phase.kind, 'busy');
  assert.equal(phase.kind === 'busy' ? phase.label : null, 'Compacting…');
  release();
  await settle(agent);
  unmount();
});

test('a failed compaction commits a notice and leaves the messages alone', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = fakeModel((turn) =>
    turn === 1 ? answer('done') : statusError(400),
  );
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.compact();
  await settle(agent);
  unmount();

  const items = agent.current!.committed;
  const last = items[items.length - 1]!;
  assert.equal(last.kind, 'notice');
  assert.match((last as NoticeItem).text, /^↯ nothing compacted/);
  assert.equal(
    items.some((item) => item.kind === 'context'),
    false,
  );
  assert.deepEqual(
    loadSession(root, null, home).messages.map((message) => message.role),
    ['user', 'assistant'],
  );
});

function crossingTurn(): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk('call-1', 'nope', '{}'),
    finishChunk('tool_calls'),
    usageChunk(880, 20),
  );
}

function gate(): {wait: Promise<void>; open: () => void} {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {wait, open};
}

function heldAnswer(
  wait: Promise<void>,
  text: string,
  tokens: number,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      await wait;
      yield textChunk(text);
      yield finishChunk('stop');
      yield usageChunk(tokens, 5);
    },
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 2_000; n += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(what);
}

function eventTypes(items: Item[]): string[] {
  return items.flatMap((item) => (item.kind === 'event' ? [item.event.type] : []));
}

test('a turn that fills the window compacts itself and says so', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice, calls} = fakeModel((turn) => {
    if (turn === 1) return crossingTurn();
    if (turn === 2) return summaryOf(SUMMARY);
    return answer('done');
  });
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  unmount();

  assert.equal(calls(), 3);
  const notice = agent.current!.committed.find(
    (item) => item.kind === 'notice',
  ) as NoticeItem | undefined;
  assert.ok(notice, 'expected an automatic compaction notice');
  assert.match(notice.text, /^↯ compacted \d+ messages?, ~[\d,]+ tokens freed$/);
  assert.deepEqual(agent.current!.checkpoints(), [
    {id: '2', index: 2, title: 'fix the cart'},
  ]);
  const stored = loadSession(root, null, home);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.match(String(stored.messages[0]!.content), /the cart was fixed in cart\.ts/);
  assert.equal(stored.messages[1]!.content, 'fix the cart');
});

test('the spinner says compacting mid-run and goes back afterwards', async () => {
  const root = workspace();
  const summary = gate();
  const rest = gate();
  const {choice} = fakeModel((turn) => {
    if (turn === 1) return crossingTurn();
    if (turn === 2) return heldAnswer(summary.wait, SUMMARY, 400);
    return heldAnswer(rest.wait, 'done', 10);
  });
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await until(() => {
    const phase = agent.current!.phase;
    return phase.kind === 'busy' && phase.label === 'Compacting…';
  }, 'the spinner never said Compacting…');
  summary.open();
  await until(() => {
    const phase = agent.current!.phase;
    return phase.kind === 'busy' && phase.label === undefined;
  }, 'the spinner never went back to the normal status');
  rest.open();
  await settle(agent);
  unmount();
});

test('the two compaction events never land in the scrollback as events', async () => {
  const root = workspace();
  const {choice} = fakeModel((turn) => {
    if (turn === 1) return crossingTurn();
    if (turn === 2) return summaryOf(SUMMARY);
    return answer('done');
  });
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  unmount();

  const types = eventTypes(agent.current!.committed);
  assert.equal(types.includes('compact_start'), false);
  assert.equal(types.includes('compact_end'), false);
});

test('a failed automatic compaction is reported and the task still finishes', async () => {
  const root = workspace();
  const {choice, calls} = fakeModel((turn) => {
    if (turn === 1) return crossingTurn();
    if (turn === 2) return statusError(400);
    return answer('done');
  });
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  unmount();

  assert.equal(calls(), 3);
  const items = agent.current!.committed;
  const failure = items.find(
    (item) => item.kind === 'event' && item.event.type === 'error',
  );
  assert.ok(failure, 'expected an error event in the scrollback');
  assert.equal(
    failure.kind === 'event' && failure.event.type === 'error'
      ? failure.event.message
      : null,
    'could not compact; the run continues',
  );
  const last = items[items.length - 1]!;
  assert.equal(last.kind, 'text');
  assert.equal((last as TextItem).text, 'done');
  assert.equal(agent.current!.phase.kind, 'idle');
});

test('resuming a compacted session shows the summary, not the original conversation', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const first = summarizingModel();
  const one = mount(root, first.choice);
  one.agent.current!.send('fix the cart');
  await settle(one.agent);
  one.agent.current!.compact();
  await settle(one.agent);
  one.unmount();
  const [older] = listSessions(root, home);

  const second = fakeModel(() => answer('still here'));
  const two = mount(root, second.choice);
  two.agent.current!.pick();
  await tick();
  two.agent.current!.resume(older!.id);
  await tick();
  two.unmount();

  const stored = loadSession(root, older!.id, home);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['assistant'],
  );
  assert.match(String(stored.messages[0]!.content), /the cart was fixed in cart\.ts/);
  assert.equal(JSON.stringify(stored.messages).includes('fix the cart'), false);
});

test('resuming after a compaction and one more turn holds the summary once', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const first = summarizingModel();
  const one = mount(root, first.choice);
  one.agent.current!.send('fix the cart');
  await settle(one.agent);
  one.agent.current!.compact();
  await settle(one.agent);
  one.agent.current!.send('and the total');
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
  assert.equal(occurrences(stored.messages, SUMMARY), 1);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(stored.messages[1]!.content, 'and the total');
  assert.equal(stored.messages[2]!.content, 'done');
  assert.equal(stored.lastUsage!.total, 15);
  const status = lastContext(two.agent.current!.committed);
  assert.equal(status.measured, true);
  assert.equal(status.used, 15);
});

test('a rewind after a compaction cuts at the right place', async () => {
  const root = workspace();
  const home = process.env.ACC_HOME!;
  const {choice} = summarizingModel();
  const {agent, unmount} = mount(root, choice);

  agent.current!.send('fix the cart');
  await settle(agent);
  agent.current!.compact();
  await settle(agent);
  agent.current!.send('and the total');
  await settle(agent);

  const rows = agent.current!.checkpoints();
  assert.deepEqual(
    rows.map((row) => row.title),
    ['and the total'],
  );
  agent.current!.pickRewind();
  await tick();
  agent.current!.rewind(rows[0]!.id);
  await tick();
  unmount();

  const stored = loadSession(root, null, home);
  assert.deepEqual(
    stored.messages.map((message) => message.role),
    ['assistant'],
  );
  assert.equal(occurrences(stored.messages, SUMMARY), 1);
  assert.equal(JSON.stringify(stored.messages).includes('and the total'), false);
});
