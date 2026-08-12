import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  connectionError,
  fakeHost,
  fakeModel,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {AgentEvent} from '../../core/host.js';
import {MAX_TURNS, runAgent} from '../../core/loop.js';
import {createSession, type Session} from '../../core/session.js';
import type {SessionStore} from '../../core/store.js';
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
  return createSession(process.cwd(), 'rules', 1_000_000);
}

function toolTurn(n: number): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${n}`, 'noop', '{}'),
    finishChunk('tool_calls'),
    usageChunk(10, 2),
  );
}

function finalTurn(): AsyncIterable<unknown> {
  return streamOf(textChunk('done'), finishChunk('stop'), usageChunk(10, 2));
}

function keepsCalling() {
  return fakeModel((turn) => toolTurn(turn));
}

function finishesAt(last: number) {
  return fakeModel((turn) => (turn < last ? toolTurn(turn) : finalTurn()));
}

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

test('the agent asks to keep going instead of giving up', async () => {
  const {choice, calls} = keepsCalling();
  const {host, asked} = fakeHost((_request, nth) => (nth === 1 ? 'once' : 'deny'));

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.command, 'continue');
  assert.match(asked[0]!.reason, /20 turns/);
  assert.equal(asked[0]!.suppressible, true);
  assert.equal(calls(), MAX_TURNS * 2);
});

test('answering no at the checkpoint stops the run', async () => {
  const {choice, calls} = keepsCalling();
  const {host, asked, events} = fakeHost(() => 'deny');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 1);
  assert.equal(calls(), MAX_TURNS);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('answering always does not ask again this run', async () => {
  const {choice, calls} = finishesAt(65);
  const {host, asked} = fakeHost(() => 'session');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 1);
  assert.equal(calls(), 65);
});

test('a session is written after every turn', async () => {
  const {choice} = finishesAt(3);
  const {host} = fakeHost();
  const seen: number[] = [];
  const store: SessionStore = {
    id: 'fake',
    dir: '/fake',
    seed() {},
    appendTurn(messages) {
      seen.push(messages.length);
    },
    appendView() {},
    close() {},
  };
  const active = session();

  await runAgent(active, choice, host, [noop], store);

  assert.equal(seen.length, 3);
  assert.ok(seen[0]! < seen[1]! && seen[1]! < seen[2]!);
  assert.equal(seen[2], active.messages.length);
});

test('a failed write does not kill the run', async () => {
  const {choice, calls} = finishesAt(3);
  const {host, events} = fakeHost();
  const store: SessionStore = {
    id: 'fake',
    dir: '/fake',
    seed() {},
    appendTurn() {
      throw new Error('disk full');
    },
    appendView() {
      throw new Error('disk full');
    },
    close() {
      throw new Error('disk full');
    },
  };

  await runAgent(session(), choice, host, [noop], store);

  assert.equal(calls(), 3);
  const reported = errors(events);
  assert.equal(reported.length, 1);
  assert.match(reported[0]!, /save/);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('a dropped connection after output keeps the partial answer', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1
      ? streamOf(textChunk('half an answer'), connectionError())
      : finalTurn(),
  );
  const {host, events} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(calls(), 1);
  const last: OpenAI.ChatCompletionMessageParam =
    active.messages[active.messages.length - 1]!;
  assert.deepEqual(last, {role: 'assistant', content: 'half an answer'});
  assert.equal(errors(events).length, 1);
});
