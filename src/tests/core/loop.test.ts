import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {z} from 'zod';
import {
  abortError,
  connectionError,
  fakeHost,
  fakeModel,
  fakeStore,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {AgentEvent} from '../../core/host.js';
import {INTERRUPTED, MAX_TURNS, runAgent} from '../../core/loop.js';
import {createSession, type Session} from '../../core/session.js';
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
  const store = fakeStore({
    appendTurn(messages) {
      seen.push(messages.length);
    },
  });
  const active = session();

  await runAgent(active, choice, host, [noop], store);

  assert.equal(seen.length, 3);
  assert.ok(seen[0]! < seen[1]! && seen[1]! < seen[2]!);
  assert.equal(seen[2], active.messages.length);
});

test('a failed write does not kill the run', async () => {
  const {choice, calls} = finishesAt(3);
  const {host, events} = fakeHost();
  const fails = (): never => {
    throw new Error('disk full');
  };
  const store = fakeStore({
    appendMessage: fails,
    appendTurn: fails,
    appendView: fails,
    rewind: fails,
    close: fails,
  });

  await runAgent(session(), choice, host, [noop], store);

  assert.equal(calls(), 3);
  const reported = errors(events);
  assert.equal(reported.length, 1);
  assert.match(reported[0]!, /save/);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('an interrupted round is saved complete', async () => {
  const {host, controller} = fakeHost();
  const {choice} = fakeModel(() =>
    streamOf(
      toolCallChunk('call-a', 'stopper', '{}', 0),
      toolCallChunk('call-b', 'stopper', '{}', 1),
      finishChunk('tool_calls'),
      usageChunk(10, 2),
    ),
  );
  const stopper: Tool = {
    name: 'stopper',
    description: 'stops the run',
    schema: z.object({}),
    async run() {
      controller.abort();
      return {text: 'ran before the stop'};
    },
  };
  const saved: OpenAI.ChatCompletionMessageParam[][] = [];
  const store = fakeStore({
    appendTurn(messages) {
      saved.push([...messages]);
    },
  });

  await runAgent(session(), choice, host, [stopper], store);

  assert.equal(saved.length, 1);
  const messages = saved[0]!;
  const assistant = messages.find(
    (message): message is OpenAI.ChatCompletionAssistantMessageParam =>
      message.role === 'assistant' && Boolean(message.tool_calls),
  )!;
  const replies = messages.filter(
    (message): message is OpenAI.ChatCompletionToolMessageParam =>
      message.role === 'tool',
  );
  assert.deepEqual(
    replies.map((reply) => reply.tool_call_id),
    assistant.tool_calls!.map((call) => call.id),
  );
  assert.equal(replies[0]!.content, 'ran before the stop');
  assert.equal(replies[1]!.content, INTERRUPTED);
});

test('an interrupted stream keeps what arrived', async () => {
  const {host, events, controller} = fakeHost();
  const {choice} = fakeModel(() => {
    controller.abort();
    return streamOf(textChunk('half an answer'), abortError());
  });
  const saved: OpenAI.ChatCompletionMessageParam[][] = [];
  const store = fakeStore({
    appendTurn(messages) {
      saved.push([...messages]);
    },
  });

  await runAgent(session(), choice, host, [noop], store);

  assert.equal(saved.length, 1);
  const messages = saved[0]!;
  assert.deepEqual(messages[messages.length - 1], {
    role: 'assistant',
    content: 'half an answer',
  });
  assert.equal(errors(events).length, 0);
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
