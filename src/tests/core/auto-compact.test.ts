import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {
  fakeHost,
  fakeModel,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import {MAX_OUTPUT_TOKENS} from '../../core/client.js';
import type {AgentEvent} from '../../core/host.js';
import {runAgent} from '../../core/loop.js';
import {
  addTask,
  createSession,
  setMeasured,
  type Session,
} from '../../core/session.js';
import type {Tool} from '../../core/tools/registry.js';

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

function measuredSession(tokens: number): Session {
  const active = session();
  setMeasured(active, tokens);
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

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

function notices(events: AgentEvent[]): number {
  return events.filter((event) => event.type === 'context_threshold_reached').length;
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

test('a turn that crosses the line is reported, never compacted', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? overTheLine(turn) : finalTurn(),
  );
  const {host, events} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(notices(events), 1);
  assert.deepEqual(active.messages.slice(0, 2), [
    {role: 'system', content: 'rules'},
    {role: 'user', content: 'rename the widget'},
  ]);
  assert.equal(
    active.messages.some(
      (message) =>
        typeof message.content === 'string' &&
        message.content.startsWith('Summary of the earlier conversation'),
    ),
    false,
  );
});

test('a turn that stays under the line says nothing', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1 ? underTheLine(turn) : finalTurn(),
  );
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 2);
  assert.equal(notices(events), 0);
});

test('the notice comes once a run, not once a turn', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn <= 3 ? overTheLine(turn) : finalTurn(),
  );
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 4);
  assert.equal(notices(events), 1);
});

test('the line moves with ACC_COMPACT_AT', async () => {
  await withThreshold('0.1', async () => {
    const crossing = fakeModel((turn) =>
      turn === 1 ? toolTurn(turn, 100_000) : finalTurn(),
    );
    const short = fakeModel((turn) =>
      turn === 1 ? toolTurn(turn, 99_000) : finalTurn(),
    );
    const {host: first, events: over} = fakeHost();
    const {host: second, events: under} = fakeHost();

    await runAgent(session(), crossing.choice, first, [noop]);
    await runAgent(session(), short.choice, second, [noop]);

    assert.equal(notices(over), 1);
    assert.equal(notices(under), 0);
  });
});

const FLOOR_ERROR =
  'the context is full and cannot be reduced further; start a new session';

test('a session past the window sends no request at all', async () => {
  const {choice, calls} = fakeModel(() => finalTurn());
  const {host, events} = fakeHost();

  await runAgent(measuredSession(1_200_000), choice, host, [noop]);

  assert.equal(calls(), 0);
  assert.deepEqual(errors(events), [FLOOR_ERROR]);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('the floor keeps the reply its own room', async () => {
  for (const [tokens, stops] of [
    [980_000, true],
    [900_000, false],
  ] as const) {
    const {choice, calls} = fakeModel(() => finalTurn());
    const {host, events} = fakeHost();

    await runAgent(measuredSession(tokens), choice, host, [noop]);

    assert.equal(
      errors(events).includes(FLOOR_ERROR),
      stops,
      `${tokens} tokens with a ${MAX_OUTPUT_TOKENS} token reply`,
    );
    assert.equal(calls(), stops ? 0 : 1, `${tokens} tokens`);
  }
});

test('a session over the line but inside the window keeps running', async () => {
  const {choice, calls} = fakeModel(() => finalTurn());
  const {host, events} = fakeHost();

  await runAgent(measuredSession(850_000), choice, host, [noop]);

  assert.equal(calls(), 1);
  assert.equal(notices(events), 1);
  assert.equal(errors(events).length, 0);
});
