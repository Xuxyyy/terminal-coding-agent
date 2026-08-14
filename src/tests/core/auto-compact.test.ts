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
import {MAX_OUTPUT_TOKENS, type ModelChoice} from '../../core/client.js';
import {SUMMARY_PREFIX} from '../../core/compact.js';
import type {AgentEvent} from '../../core/host.js';
import {runAgent} from '../../core/loop.js';
import {messagesOf, readRecords} from '../../core/records.js';
import {
  addTask,
  createSession,
  setMeasured,
  type Session,
} from '../../core/session.js';
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
  const active = createSession(process.cwd(), 'rules', 1_000_000);
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
  return toolTurn(n, 902_000);
}

function underTheLine(n: number): AsyncIterable<unknown> {
  return toolTurn(n, 12_000);
}

function finalTurn(): AsyncIterable<unknown> {
  return streamOf(textChunk('done'), finishChunk('stop'), usageChunk(10, 2));
}

const LONG_RECAP = 'a recap too long to fit under the line. '.repeat(12);

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
      contextWindow: 1_000_000,
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

test('one compaction that frees nothing is not reported and not the last', async () => {
  await withThreshold('0.0001', async () => {
    const {choice, calls} = fakeModel((turn) => {
      if (turn === 2) return summaryTurn(LONG_RECAP);
      return turn === 1 ? underTheLine(turn) : finalTurn();
    });
    const {host, events} = fakeHost();

    await runAgent(session(), choice, host, [noop]);

    assert.equal(calls(), 3);
    assert.equal(compactions(events), 1);
    assert.equal(errors(events).length, 0);
  });
});

test('two compactions that free nothing stop the trigger and say so', async () => {
  await withThreshold('0.0001', async () => {
    const {choice, calls} = fakeModel((turn) => {
      if (turn === 2 || turn === 4) return summaryTurn(LONG_RECAP);
      if (turn === 5) return finalTurn();
      return underTheLine(turn);
    });
    const {host, events} = fakeHost();

    await runAgent(session(), choice, host, [noop]);

    assert.equal(calls(), 5);
    assert.equal(compactions(events), 2);
    assert.deepEqual(errors(events), [
      'compacting no longer frees space; the context may fill up',
    ]);
  });
});

test('the two guards do not share a counter', async () => {
  await withThreshold('0.0001', async () => {
    const {choice, calls} = fakeModel((turn) => {
      if (turn === 2) return statusError(400);
      if (turn === 4) return finalTurn();
      return underTheLine(turn);
    });
    const {host, events} = fakeHost();

    await runAgent(session(), choice, host, [noop]);

    assert.equal(calls(), 4);
    assert.equal(compactions(events), 1);
    assert.deepEqual(errors(events), ['could not compact; the run continues']);
  });
});

test('the line moves with ACC_COMPACT_AT', async () => {
  await withThreshold('0.1', async () => {
    const crossing = fakeModel((turn) => {
      if (turn === 1) return toolTurn(turn, 100_000);
      if (turn === 2) return summaryTurn('a short recap');
      return finalTurn();
    });
    const short = fakeModel((turn) =>
      turn === 1 ? toolTurn(turn, 99_000) : finalTurn(),
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

const FLOOR_ERROR =
  'the context is full and cannot be reduced further; start a new session';

function measuredSession(tokens: number): Session {
  const active = session();
  setMeasured(active, tokens);
  return active;
}

test('a session past the window stops instead of sending', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? statusError(400) : finalTurn(),
  );
  const {host, events} = fakeHost();

  await runAgent(measuredSession(1_200_000), choice, host, [noop]);

  assert.equal(calls(), 1);
  assert.deepEqual(errors(events), [
    'could not compact; the run continues',
    FLOOR_ERROR,
  ]);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('the floor keeps the reply its own room', async () => {
  for (const [tokens, stops] of [
    [980_000, true],
    [900_000, false],
  ] as const) {
    const {choice, calls} = fakeModel((turn) =>
      turn === 1 ? statusError(400) : finalTurn(),
    );
    const {host, events} = fakeHost();

    await runAgent(measuredSession(tokens), choice, host, [noop]);

    assert.equal(
      errors(events).includes(FLOOR_ERROR),
      stops,
      `${tokens} tokens with a ${MAX_OUTPUT_TOKENS} token reply`,
    );
    assert.equal(calls(), stops ? 1 : 2, `${tokens} tokens`);
  }
});

test('the floor lets compaction have its turn first', async () => {
  const {choice, calls} = fakeModel((turn) => {
    if (turn === 1) return summaryTurn('a short recap');
    return finalTurn();
  });
  const {host, events} = fakeHost();

  await runAgent(measuredSession(850_000), choice, host, [noop]);

  assert.equal(compactions(events), 1);
  assert.equal(calls(), 2);
  assert.equal(errors(events).length, 0);
});

test('the turn after an automatic compaction writes neither the summary nor the task again', async () => {
  const root = tempDir('acc-home-');
  const work = tempDir('acc-work-');
  try {
    const store = startSession(work, root);
    const active = createSession(work, 'rules', 1_000_000);
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
