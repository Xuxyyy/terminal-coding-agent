import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import {
  INTERRUPTED,
  INTERRUPTED_TURN,
  MAX_STEPS,
  runAgent,
} from '../../core/loop.js';
import {filesDir} from '../../core/history.js';
import {createSession, type Session} from '../../core/session.js';
import {startSession} from '../../core/store.js';
import {writeFile} from '../../core/tools/write.js';
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

function toolResponse(n: number): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(`call-${n}`, 'noop', '{}'),
    finishChunk('tool_calls'),
    usageChunk(10, 2),
  );
}

function finalResponse(): AsyncIterable<unknown> {
  return streamOf(textChunk('done'), finishChunk('stop'), usageChunk(10, 2));
}

function keepsCalling() {
  return fakeModel((nth) => toolResponse(nth));
}

function finishesAt(last: number) {
  return fakeModel((nth) => (nth < last ? toolResponse(nth) : finalResponse()));
}

function errors(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'error' ? [event.message] : [],
  );
}

function markers(active: Session): number {
  return active.messages.filter(
    (message) => message.role === 'user' && message.content === INTERRUPTED_TURN,
  ).length;
}

test('the agent asks to keep going instead of giving up', async () => {
  const {choice, calls} = keepsCalling();
  const {host, asked} = fakeHost((_request, nth) => (nth === 1 ? 'once' : 'deny'));

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.command, 'continue');
  assert.match(asked[0]!.reason, /20 steps/);
  assert.equal(asked[0]!.suppressible, true);
  assert.equal(calls(), MAX_STEPS * 2);
});

test('answering no at the checkpoint stops the run', async () => {
  const {choice, calls} = keepsCalling();
  const {host, asked, events} = fakeHost(() => 'deny');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 1);
  assert.equal(calls(), MAX_STEPS);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('answering no at the checkpoint says how many steps ran', async () => {
  const {choice} = keepsCalling();
  const {host, events} = fakeHost(() => 'deny');

  await runAgent(session(), choice, host, [noop]);

  assert.deepEqual(errors(events), [
    `stopped after ${MAX_STEPS} steps without finishing`,
  ]);
});

test('escaping at the checkpoint stops without reporting a refusal', async () => {
  const {choice, calls} = keepsCalling();
  const {host, events, controller} = fakeHost(() => {
    controller.abort();
    return 'deny';
  });

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), MAX_STEPS);
  assert.deepEqual(
    events.filter(
      (event) => event.type === 'error' || event.type === 'turn_end',
    ),
    [],
  );
});

test('answering always does not ask again this run', async () => {
  const {choice, calls} = finishesAt(65);
  const {host, asked} = fakeHost(() => 'session');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 1);
  assert.equal(calls(), 65);
});

test('a session is written after every step', async () => {
  const {choice} = finishesAt(3);
  const {host} = fakeHost();
  const seen: number[] = [];
  const store = fakeStore({
    appendStep(messages) {
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
    appendStep: fails,
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

test('an interrupted step is saved complete', async () => {
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
    appendStep(messages) {
      saved.push([...messages]);
    },
  });

  await runAgent(session(), choice, host, [stopper], store);

  assert.equal(saved.length, 2);
  const marked = saved[1]!;
  assert.deepEqual(marked[marked.length - 1], {
    role: 'user',
    content: INTERRUPTED_TURN,
  });
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
    appendStep(messages) {
      saved.push([...messages]);
    },
  });

  await runAgent(session(), choice, host, [noop], store);

  assert.equal(saved.length, 2);
  const marked = saved[1]!;
  assert.deepEqual(marked[marked.length - 1], {
    role: 'user',
    content: INTERRUPTED_TURN,
  });
  const messages = saved[0]!;
  assert.deepEqual(messages[messages.length - 1], {
    role: 'assistant',
    content: 'half an answer',
  });
  assert.equal(errors(events).length, 0);
});

test('an interrupted stream ends with the marker after the partial text', async () => {
  const {host, controller} = fakeHost();
  const {choice} = fakeModel(() => {
    controller.abort();
    return streamOf(textChunk('half an answer'), abortError());
  });
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.deepEqual(active.messages.slice(-2), [
    {role: 'assistant', content: 'half an answer'},
    {role: 'user', content: INTERRUPTED_TURN},
  ]);
});

test('an interrupted tool batch puts the marker after the tool replies', async () => {
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
  const active = session();

  await runAgent(active, choice, host, [stopper]);

  assert.deepEqual(active.messages.slice(-3), [
    {role: 'tool', tool_call_id: 'call-a', content: 'ran before the stop'},
    {role: 'tool', tool_call_id: 'call-b', content: INTERRUPTED},
    {role: 'user', content: INTERRUPTED_TURN},
  ]);
});

test('escaping at the checkpoint leaves the marker as the last message', async () => {
  const {choice} = keepsCalling();
  const {host, controller} = fakeHost(() => {
    controller.abort();
    return 'deny';
  });
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.deepEqual(active.messages[active.messages.length - 1], {
    role: 'user',
    content: INTERRUPTED_TURN,
  });
});

test('a turn that ends on its own is not marked as interrupted', async () => {
  const {choice} = finishesAt(3);
  const {host} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [noop]);

  assert.equal(markers(active), 0);
});

test('an interrupted turn carries the marker exactly once', async () => {
  const {host, controller} = fakeHost();
  const {choice} = fakeModel(() =>
    streamOf(
      toolCallChunk('call-a', 'stopper', '{}', 0),
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
  const active = session();

  await runAgent(active, choice, host, [stopper]);

  assert.equal(markers(active), 1);
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeResponse(target: string, content: string): AsyncIterable<unknown> {
  return streamOf(
    toolCallChunk(
      'call-write',
      'write_file',
      JSON.stringify({path: target, content}),
    ),
    finishChunk('tool_calls'),
    usageChunk(10, 2),
  );
}

test('the old file is in the session before the agent overwrites it', async () => {
  const work = tempDir('acc-work-');
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
  const {choice} = fakeModel((nth) =>
    nth === 1 ? writeResponse('note.txt', 'two\n') : finalResponse(),
  );
  const {host} = fakeHost();
  const store = startSession(work, tempDir('acc-home-'));

  await runAgent(
    createSession(work, 'rules', 1_000_000),
    choice,
    host,
    [writeFile],
    store,
  );

  const sha = crypto.createHash('sha256').update('one\n').digest('hex');
  assert.deepEqual(
    store.records().filter((record) => record.kind === 'code'),
    [{kind: 'code', path: 'note.txt', before: sha}],
  );
  assert.equal(fs.readFileSync(path.join(filesDir(store.dir), sha), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'two\n');
});

test('a file the agent creates is recorded as having no old version', async () => {
  const work = tempDir('acc-work-');
  const {choice} = fakeModel((nth) =>
    nth === 1 ? writeResponse('new.txt', 'fresh\n') : finalResponse(),
  );
  const {host} = fakeHost();
  const store = startSession(work, tempDir('acc-home-'));

  await runAgent(
    createSession(work, 'rules', 1_000_000),
    choice,
    host,
    [writeFile],
    store,
  );

  assert.deepEqual(
    store.records().filter((record) => record.kind === 'code'),
    [{kind: 'code', path: 'new.txt', before: null}],
  );
  assert.equal(fs.existsSync(filesDir(store.dir)), false);
});

test('without a session nothing is captured and the write still lands', async () => {
  const work = tempDir('acc-work-');
  fs.writeFileSync(path.join(work, 'note.txt'), 'one\n');
  const {choice} = fakeModel((nth) =>
    nth === 1 ? writeResponse('note.txt', 'two\n') : finalResponse(),
  );
  const {host, events} = fakeHost();

  await runAgent(createSession(work, 'rules', 1_000_000), choice, host, [writeFile]);

  assert.deepEqual(errors(events), []);
  assert.equal(fs.readFileSync(path.join(work, 'note.txt'), 'utf8'), 'two\n');
});

test('a dropped connection after output keeps the partial answer', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? streamOf(textChunk('half an answer'), connectionError())
      : finalResponse(),
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
