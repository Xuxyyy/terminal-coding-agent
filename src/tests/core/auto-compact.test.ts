import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  fakeHost,
  fakeModel,
  finishChunk,
  statusError,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {ModelChoice} from '../../core/client.js';
import {SUMMARY_PREFIX} from '../../core/compact.js';
import type {AgentEvent} from '../../core/host.js';
import {runAgent} from '../../core/loop.js';
import {messagesOf, readRecords} from '../../core/records.js';
import {addTask, createSession, type Session} from '../../core/session.js';
import {startSession} from '../../core/store.js';
import type {Tool} from '../../core/tools/registry.js';

type Body = OpenAI.ChatCompletionCreateParams;

const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
  async run() {
    return {text: 'ok'};
  },
};

function session(): Session {
  const active = createSession(process.cwd(), 'rules', 1_000);
  addTask(active, 'rename the widget');
  return active;
}

function toolTurn(n: number, total: number): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${n}`, 'noop', '{}'),
    finishChunk('tool_calls'),
    usageChunk(total - 2, 2),
  );
}

function overTheLine(n: number): AsyncIterable<unknown> {
  return toolTurn(n, 902);
}

function underTheLine(n: number): AsyncIterable<unknown> {
  return toolTurn(n, 12);
}

function finalTurn(): AsyncIterable<unknown> {
  return streamOf(textChunk('done'), finishChunk('stop'), usageChunk(10, 2));
}

function summaryTurn(text: string): AsyncIterable<unknown> {
  return streamOf(textChunk(text), finishChunk('stop'), usageChunk(20, 5));
}

function recordingModel(next: (turn: number) => AsyncIterable<unknown>): {
  choice: ModelChoice;
  bodies: Body[];
} {
  const bodies: Body[] = [];
  const create = async (body: Body): Promise<unknown> => {
    bodies.push(body);
    return next(bodies.length);
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-model',
      label: 'Fake',
      contextWindow: 1_000,
    },
    bodies,
  };
}

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

function compactions(events: AgentEvent[]): number {
  return events.filter((event) => event.type === 'compact_start').length;
}

async function withThreshold(
  value: string,
  run: () => Promise<void>,
): Promise<void> {
  const before = process.env.ACC_COMPACT_AT;
  process.env.ACC_COMPACT_AT = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.ACC_COMPACT_AT;
    else process.env.ACC_COMPACT_AT = before;
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a turn that crosses the line is compacted before the next one', async () => {
  const {choice, calls} = fakeModel((turn) => {
    if (turn === 1) return overTheLine(turn);
    if (turn === 2) return summaryTurn('a short recap');
    return finalTurn();
  });
  const {host} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 3);
  assert.deepEqual(active.messages, [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: `${SUMMARY_PREFIX}a short recap`},
    {role: 'user', content: 'rename the widget'},
    {role: 'assistant', content: 'done'},
  ]);
});

test('a turn that stays under the line is not compacted', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? underTheLine(turn) : finalTurn(),
  );
  const {host, events} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(compactions(events), 0);
  assert.deepEqual(active.messages.slice(0, 2), [
    {role: 'system', content: 'rules'},
    {role: 'user', content: 'rename the widget'},
  ]);
});

test('only the summarizing call is sent without tool definitions', async () => {
  const {choice, bodies} = recordingModel((turn) => {
    if (turn === 1) return overTheLine(turn);
    if (turn === 2) return summaryTurn('a short recap');
    return finalTurn();
  });
  const {host} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.deepEqual(
    bodies.map((body) => body.tools?.length),
    [1, 0, 1],
  );
});

test('a failed compaction is reported once and never retried', async () => {
  const {choice, calls} = fakeModel((turn) => {
    if (turn === 2) return statusError(400);
    if (turn === 4) return finalTurn();
    return overTheLine(turn);
  });
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 4);
  assert.equal(compactions(events), 1);
  assert.deepEqual(errors(events), ['could not compact; the run continues']);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('a compaction that frees nothing stops the trigger for the run', async () => {
  await withThreshold('0.0001', async () => {
    const {choice, calls} = fakeModel((turn) => {
      if (turn === 2) return summaryTurn('a short recap');
      if (turn === 4) return finalTurn();
      return underTheLine(turn);
    });
    const {host, events} = fakeHost();

    await runAgent(session(), choice, host, [noop]);

    assert.equal(calls(), 4);
    assert.equal(compactions(events), 1);
    assert.equal(errors(events).length, 0);
  });
});

test('the line moves with ACC_COMPACT_AT', async () => {
  await withThreshold('0.1', async () => {
    const crossing = fakeModel((turn) => {
      if (turn === 1) return toolTurn(turn, 100);
      if (turn === 2) return summaryTurn('a short recap');
      return finalTurn();
    });
    const short = fakeModel((turn) =>
      turn === 1 ? toolTurn(turn, 99) : finalTurn(),
    );
    const {host: first} = fakeHost();
    const {host: second, events} = fakeHost();

    await runAgent(session(), crossing.choice, first, [noop]);
    await runAgent(session(), short.choice, second, [noop]);

    assert.equal(crossing.calls(), 3);
    assert.equal(short.calls(), 2);
    assert.equal(compactions(events), 0);
  });
});

test('the turn after an automatic compaction writes neither the summary nor the task again', async () => {
  const root = tempDir('acc-home-');
  const work = tempDir('acc-work-');
  try {
    const store = startSession(work, root);
    const active = createSession(work, 'rules', 1_000);
    store.appendMessage(addTask(active, 'rename the widget'));
    const {choice, calls} = fakeModel((turn) => {
      if (turn === 1) return overTheLine(turn);
      if (turn === 2) return summaryTurn('a short recap');
      if (turn === 3) return underTheLine(turn);
      return finalTurn();
    });
    const {host} = fakeHost();

    await runAgent(active, choice, host, [noop], store);
    store.close();

    const written = messagesOf(readRecords(store.dir));
    assert.equal(calls(), 4);
    assert.deepEqual(written.slice(0, 2), [
      {role: 'assistant', content: `${SUMMARY_PREFIX}a short recap`},
      {role: 'user', content: 'rename the widget'},
    ]);
    assert.equal(
      written.filter(
        (message) => message.content === `${SUMMARY_PREFIX}a short recap`,
      ).length,
      1,
    );
    assert.equal(
      written.filter((message) => message.content === 'rename the widget').length,
      1,
    );
    assert.deepEqual(written[written.length - 1], {
      role: 'assistant',
      content: 'done',
    });
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(work, {recursive: true, force: true});
  }
});
