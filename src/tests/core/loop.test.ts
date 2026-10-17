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
  reasoningChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {AgentEvent, Usage} from '../../core/host.js';
import {MAX_OUTPUT_TOKENS} from '../../core/client.js';
import {
  COMPLETION_AUDIT,
  INTERRUPTED,
  INTERRUPTED_TURN,
  NORMAL_STEP_POLICY,
  runAgent,
} from '../../core/loop.js';
import {filesDir} from '../../core/history.js';
import {addTask, createSession, projectedTokens, restoreMessages, type Session} from '../../core/session.js';
import {loadSession, startSession} from '../../core/store.js';
import {writeFile} from '../../core/tools/write.js';
import type {Tool} from '../../core/tools/registry.js';
import {estimateMessage} from '../../core/tokens.js';

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

test('the next tool-enabled request receives opaque continuation state', async () => {
  const sent: OpenAI.ChatCompletionMessageParam[][] = [];
  const {choice} = fakeModel((nth, body) => {
    sent.push(
      [...(((body as {messages?: OpenAI.ChatCompletionMessageParam[]})?.messages) ?? [])],
    );
    if (nth === 1) {
      return streamOf(
        reasoningChunk('keep this provider state'),
        toolCallChunk('call-1', 'noop', '{}'),
        finishChunk('tool_calls'),
        usageChunk(10, 2),
      );
    }
    return finalResponse();
  });
  const {host} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(sent.length, 2);
  assert.ok(
    sent[1]!.some(
      (message) =>
        message.role === 'assistant' &&
        (message as {reasoning_content?: unknown}).reasoning_content ===
          'keep this provider state',
    ),
  );
});

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
  assert.match(asked[0]!.reason, /60 steps/);
  assert.equal(asked[0]!.suppressible, false);
  assert.equal(calls(), NORMAL_STEP_POLICY.hardGateEvery * 2);
});

test('a short turn receives neither a completion audit nor a gate', async () => {
  const sent: OpenAI.ChatCompletionMessageParam[][] = [];
  const {choice} = fakeModel((nth, body) => {
    sent.push([
      ...(((body as {messages?: OpenAI.ChatCompletionMessageParam[]})?.messages) ?? []),
    ]);
    return nth < NORMAL_STEP_POLICY.softAuditEvery ? toolResponse(nth) : finalResponse();
  });
  const {host, asked} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 0);
  assert.equal(sent.length, NORMAL_STEP_POLICY.softAuditEvery);
  assert.ok(
    sent.every((messages) =>
      messages.every(
        (message) =>
          typeof message.content !== 'string' || !message.content.includes(COMPLETION_AUDIT),
      ),
    ),
  );
});

test('the request after twenty completed turns appends and persists a completion audit', async () => {
  const sent: OpenAI.ChatCompletionMessageParam[][] = [];
  const {choice} = fakeModel((nth, body) => {
    sent.push([
      ...(((body as {messages?: OpenAI.ChatCompletionMessageParam[]})?.messages) ?? []),
    ]);
    if (nth === 21) {
      assert.deepEqual(loadSession(work, store.id, home).messages, active.messages.slice(1));
    }
    return nth <= 21 ? toolResponse(nth) : finalResponse();
  });
  const {host, asked, events} = fakeHost();
  const work = tempDir('acc-work-');
  const home = tempDir('acc-home-');
  const active = createSession(work, 'rules', 1_000_000);
  addTask(active, 'finish the required work');
  const initial = structuredClone(active.messages);
  const store = startSession(work, home);

  await runAgent(active, choice, host, [noop], store);

  assert.equal(asked.length, 0);
  assert.equal(sent.length, 22);
  const auditedRequest = sent[20]!;
  const auditedSystem = auditedRequest.at(-1);
  assert.equal(auditedSystem?.role, 'system');
  assert.equal(typeof auditedSystem?.content, 'string');
  assert.match(auditedSystem!.content as string, new RegExp(COMPLETION_AUDIT));
  assert.deepEqual(auditedRequest.slice(0, initial.length), initial);
  assert.deepEqual(auditedRequest.slice(0, sent[19]!.length), sent[19]);
  assert.equal(auditedRequest.at(-2)?.role, 'tool');
  assert.deepEqual(sent[21]!.slice(0, auditedRequest.length), auditedRequest);
  assert.equal(sent[21]!.at(-1)?.role, 'tool');
  assert.equal(active.messages.filter((message) => message.role === 'system').length, 2);
  assert.ok(
    events.every(
      (event) => event.type !== 'text_delta' || !event.text.includes(COMPLETION_AUDIT),
    ),
  );
  const stored = loadSession(work, store.id, home);
  assert.deepEqual(stored.messages, active.messages.slice(1));
  const restored = createSession(work, 'rules', 1_000_000);
  restoreMessages(restored, stored.messages);
  assert.deepEqual(restored.messages, active.messages);
  assert.deepEqual(restored.asked, ['finish the required work']);
  const resumed = fakeModel((_nth, body) => {
    const messages = (body as {messages: OpenAI.ChatCompletionMessageParam[]}).messages;
    assert.deepEqual(messages.slice(0, sent[21]!.length), sent[21]);
    assert.equal(messages.at(-1)?.content, 'done');
    return finalResponse();
  });
  await runAgent(restored, resumed.choice, host, [noop]);
  assert.equal(resumed.calls(), 1);
  assert.deepEqual(errors(events), []);
  store.close();
});

test('a completion audit survives a failed or interrupted following request', async () => {
  for (const interrupted of [false, true]) {
    const work = tempDir('acc-work-');
    const home = tempDir('acc-home-');
    const active = createSession(work, 'rules', 1_000_000);
    const store = startSession(work, home);
    const {host, controller} = fakeHost();
    const {choice, calls} = fakeModel((nth) => {
      if (nth <= 20) return toolResponse(nth);
      const saved = loadSession(work, store.id, home).messages;
      assert.match(saved.at(-1)!.content as string, /20 model turns completed/);
      if (interrupted) controller.abort();
      return streamOf(interrupted ? abortError() : new Error('fixture stream failed'));
    });

    await runAgent(active, choice, host, [noop], store);

    assert.equal(calls(), 21);
    assert.deepEqual(loadSession(work, store.id, home).messages, active.messages.slice(1));
    assert.equal(active.messages.filter((message) =>
      message.role === 'system' && typeof message.content === 'string' && message.content.includes(COMPLETION_AUDIT),
    ).length, 1);
    assert.equal(markers(active), interrupted ? 1 : 0);
    store.close();
  }
});

test('the request-fit guard counts a reminder once and sends it only when it fits', async () => {
  for (const fits of [false, true]) {
    const active = session();
    const {host, events} = fakeHost();
    let fitProjection = 0;
    const {choice, calls} = fakeModel((nth) => {
      if (nth === 21) {
        fitProjection = projectedTokens(active, [noop]) + MAX_OUTPUT_TOKENS;
        return finalResponse();
      }
      return toolResponse(nth);
    });
    const tool: Tool = {
      ...noop,
      async run() {
        if (calls() === 20) {
          const reminder = {
            role: 'system' as const,
            content: 'Progress review: 20 model turns completed. ' +
              '40 model turns remain before the next continuation checkpoint, at turn 60.' +
              `\n\n${COMPLETION_AUDIT}`,
          };
          const toolResult = {role: 'tool' as const, tool_call_id: 'call-20', content: 'ok'};
          active.contextWindow = projectedTokens(active, [tool]) +
            estimateMessage(toolResult) + estimateMessage(reminder) + MAX_OUTPUT_TOKENS -
            (fits ? 0 : 1);
        }
        return {text: 'ok'};
      },
    };

    await runAgent(active, choice, host, [tool]);

    assert.equal(calls(), fits ? 21 : 20);
    assert.equal(active.messages.filter((message) =>
      message.role === 'system' && typeof message.content === 'string' && message.content.includes(COMPLETION_AUDIT),
    ).length, fits ? 1 : 0);
    if (fits) assert.equal(fitProjection, active.contextWindow);
    else assert.match(errors(events).at(-1)!, /exceed the context window/);
  }
});

test('coincident review and final warning append once, and short budgets keep their warning', async () => {
  for (const [maxSteps, expected] of [[30, [20]], [10, [1]], [1, []]] as const) {
    const active = session();
    const {choice, calls} = keepsCalling();
    const {host, asked} = fakeHost();

    const result = await runAgent(active, choice, host, [noop], undefined, {maxSteps});

    assert.equal(result, 'step_limit');
    assert.equal(calls(), maxSteps);
    assert.equal(asked.length, 0);
    const reminders = active.messages.filter((message) => message.role === 'system').slice(1);
    assert.equal(reminders.length, expected.length);
    reminders.forEach((message, index) => {
      assert.match(message.content as string, new RegExp(`${expected[index]} model turns completed`));
      assert.match(message.content as string, /clearly report what remains unfinished/);
    });
  }
});

test('finishing between the audit and gate does not ask to continue', async () => {
  const {choice, calls} = finishesAt(25);
  const {host, asked} = fakeHost();

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), 25);
  assert.equal(asked.length, 0);
});

test('answering no at the checkpoint stops the run', async () => {
  const {choice, calls} = keepsCalling();
  const {host, asked, events} = fakeHost(() => 'deny');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 1);
  assert.equal(calls(), NORMAL_STEP_POLICY.hardGateEvery);
  assert.ok(events.some((event) => event.type === 'turn_end'));
});

test('answering no at the checkpoint says how many steps ran', async () => {
  const {choice} = keepsCalling();
  const {host, events} = fakeHost(() => 'deny');

  await runAgent(session(), choice, host, [noop]);

  assert.deepEqual(errors(events), [
    `stopped after ${NORMAL_STEP_POLICY.hardGateEvery} steps without finishing`,
  ]);
});

test('escaping at the checkpoint stops without reporting a refusal', async () => {
  const {choice, calls} = keepsCalling();
  const {host, events, controller} = fakeHost(() => {
    controller.abort();
    return 'deny';
  });

  await runAgent(session(), choice, host, [noop]);

  assert.equal(calls(), NORMAL_STEP_POLICY.hardGateEvery);
  assert.deepEqual(
    events.filter(
      (event) => event.type === 'error' || event.type === 'turn_end',
    ),
    [],
  );
});

test('a session answer cannot suppress later step gates', async () => {
  const {choice, calls} = finishesAt(125);
  const {host, asked} = fakeHost(() => 'session');

  await runAgent(session(), choice, host, [noop]);

  assert.equal(asked.length, 2);
  assert.equal(calls(), 125);
});

test('an approved segment receives another audit and another gate', async () => {
  const auditedRequests: number[] = [];
  const auditedPrompts: string[] = [];
  let previous: OpenAI.ChatCompletionMessageParam[] = [];
  const {choice, calls} = fakeModel((nth, body) => {
    const messages =
      ((body as {messages?: OpenAI.ChatCompletionMessageParam[]})?.messages) ?? [];
    assert.deepEqual(messages.slice(0, previous.length), previous);
    previous = structuredClone(messages);
    const last = messages.at(-1);
    if (last?.role === 'system' && typeof last.content === 'string' && last.content.includes(COMPLETION_AUDIT)) {
      auditedRequests.push(nth);
      auditedPrompts.push(last.content as string);
    }
    return toolResponse(nth);
  });
  const {host, asked} = fakeHost((_request, nth) => (nth === 1 ? 'once' : 'deny'));

  await runAgent(session(), choice, host, [noop]);

  assert.deepEqual(auditedRequests, [21, 41, 51, 61, 81, 101, 111]);
  assert.match(auditedPrompts[0]!, /20 model turns completed.*40 model turns remain.*turn 60/);
  assert.match(auditedPrompts[2]!, /50 model turns completed.*10 model turns remain/);
  assert.match(auditedPrompts[2]!, /clearly report what remains unfinished/);
  assert.match(auditedPrompts[3]!, /60 model turns completed.*60 model turns remain.*turn 120/);
  assert.doesNotMatch(auditedPrompts[3]!, /clearly report what remains unfinished/);
  assert.equal(asked.length, 2);
  assert.equal(calls(), 120);
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

test('a tool is handed the same model the run was started with', async () => {
  const {choice} = fakeModel((nth) =>
    nth === 1
      ? streamOf(
          toolCallChunk('call-a', 'recorder', '{}'),
          finishChunk('tool_calls'),
          usageChunk(10, 2),
        )
      : finalResponse(),
  );
  const {host} = fakeHost();
  let seen: unknown;
  const recorder: Tool = {
    name: 'recorder',
    description: 'records the model it was given',
    schema: z.object({}),
    async run(_args, ctx) {
      seen = ctx.choice;
      return {text: 'ok'};
    },
  };

  await runAgent(session(), choice, host, [recorder]);

  assert.strictEqual(seen, choice);
});

const TOOL_USAGE: Usage = {prompt: 100, completion: 20, total: 120};

const reporter: Tool = {
  name: 'reporter',
  description: 'reports tokens of its own',
  schema: z.object({}),
  async run() {
    return {text: 'ok', usage: TOOL_USAGE};
  },
};

function callsReporter(answer: () => AsyncIterable<unknown>) {
  return fakeModel((nth) =>
    nth === 1
      ? streamOf(
          toolCallChunk('call-a', 'reporter', '{}'),
          finishChunk('tool_calls'),
          usageChunk(10, 2),
        )
      : answer(),
  );
}

function endUsage(events: AgentEvent[]): Usage | null {
  const end = events.find((event) => event.type === 'turn_end');
  return end?.type === 'turn_end' ? end.usage : null;
}

test('the tokens a tool reports are part of the turn total', async () => {
  const {choice} = callsReporter(finalResponse);
  const {host, events} = fakeHost();

  await runAgent(session(), choice, host, [reporter]);

  assert.deepEqual(endUsage(events), {prompt: 120, completion: 24, total: 144});
});

test('the tokens a tool reports are part of the session total', async () => {
  const {choice} = callsReporter(finalResponse);
  const {host} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [reporter]);

  assert.deepEqual(active.usage, {prompt: 120, completion: 24, total: 144});
});

test('the tokens a tool reports do not move the context bar', async () => {
  const {choice} = callsReporter(() =>
    streamOf(textChunk('done'), finishChunk('stop')),
  );
  const {host} = fakeHost();
  const active = session();

  await runAgent(active, choice, host, [reporter]);

  assert.equal(active.usage.total, 132);
  assert.equal(active.lastContextTokens, 12);
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
