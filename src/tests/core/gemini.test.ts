import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {geminiClient, interactionRequest, GEMINI_STEPS_PREFIX} from '../../core/gemini.js';
import {ModelTimeoutError, streamStep, StreamFailure, type ModelChoice} from '../../core/client.js';
import {assistantMessage} from '../../core/messages.js';
import {loadSession, startSession} from '../../core/store.js';
import {connectionError, fakeHost, streamOf} from '../fakes.js';

function choice(invoke: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): ModelChoice {
  return {
    client: geminiClient('test-key', invoke),
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
  };
}

const tool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a local file',
    parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
  },
};

test('stateless requests offer only local functions', () => {
  const request = interactionRequest({
    model: 'gemini-3.8-flash',
    messages: [
      {role: 'system', content: 'Follow the local rules'},
      {role: 'user', content: 'Read a file'},
    ],
    tools: [tool],
    stream: true,
    max_tokens: 32_000,
  });
  assert.equal(request.store, false);
  assert.equal(request.model, 'gemini-3.8-flash');
  assert.equal(request.system_instruction, 'Follow the local rules');
  assert.deepEqual(request.input, [{type: 'user_input', content: [{type: 'text', text: 'Read a file'}]}]);
  assert.deepEqual(request.tools, [{
    type: 'function', name: 'read_file', description: 'Read a local file',
    parameters: tool.function.parameters,
  }]);
  assert.equal('agent' in request, false);
  assert.equal('previous_interaction_id' in request, false);
});

test('streamed Gemini steps survive a local tool round trip', async () => {
  const sent: Record<string, unknown>[] = [];
  const model = choice(async (request) => {
    sent.push(request);
    return streamOf(
      {event_type: 'step.start', index: 0, step: {type: 'thought'}},
      {event_type: 'step.delta', index: 0, delta: {type: 'thought_signature', signature: 'signed'}},
      {event_type: 'step.stop', index: 0},
      {event_type: 'step.start', index: 1, step: {type: 'model_output'}},
      {event_type: 'step.delta', index: 1, delta: {type: 'text', text: 'Reading '}},
      {event_type: 'step.delta', index: 1, delta: {type: 'text', text: 'now'}},
      {event_type: 'step.stop', index: 1},
      {event_type: 'step.start', index: 2, step: {type: 'function_call', id: 'call-1', name: 'read_file', arguments: {}}},
      {event_type: 'step.delta', index: 2, delta: {type: 'arguments_delta', arguments: '{"path":'}},
      {event_type: 'step.delta', index: 2, delta: {type: 'arguments_delta', arguments: '"a.ts"}'}},
      {event_type: 'step.stop', index: 2},
      {event_type: 'interaction.completed', interaction: {
        status: 'requires_action',
        usage: {total_input_tokens: 20, total_output_tokens: 5, total_tokens: 30, total_cached_tokens: 2},
      }},
    );
  });
  const {host, events, modelUsage} = fakeHost();
  const messages = [
    {role: 'system' as const, content: 'rules'},
    {role: 'user' as const, content: 'Read a.ts'},
  ];
  const response = await streamStep(model, messages, [tool], host);
  assert.equal(response.content, 'Reading now');
  assert.deepEqual(response.toolCalls, [{id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}'}]);
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.usage.total, 30);
  assert.deepEqual(modelUsage[0], {
    inputTokens: 20, outputTokens: 5, totalTokens: 30,
    cacheHitInputTokens: 2, cacheMissInputTokens: 18,
  });
  assert.deepEqual(events.filter((event) => event.type === 'text_delta').map((event) => event.text), ['Reading ', 'now']);
  assert.equal(sent[0]?.store, false);

  const assistant = assistantMessage(response.content, response.toolCalls, response.continuation);
  assert.ok((assistant as {reasoning_content?: string}).reasoning_content?.startsWith(GEMINI_STEPS_PREFIX));
  const next = interactionRequest({
    model: model.model,
    messages: [...messages, assistant, {role: 'tool', tool_call_id: 'call-1', content: 'file text'}],
    tools: [tool],
  });
  assert.deepEqual(next.input, [
    {type: 'user_input', content: [{type: 'text', text: 'Read a.ts'}]},
    {type: 'thought', signature: 'signed'},
    {type: 'model_output', content: [{type: 'text', text: 'Reading now'}]},
    {type: 'function_call', id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}},
    {type: 'function_result', call_id: 'call-1', name: 'read_file', result: [{type: 'text', text: 'file text'}]},
  ]);
});

test('an interrupted stream does not save incomplete Gemini steps', async () => {
  const model = choice(async () => streamOf(
    {event_type: 'step.start', index: 0, step: {type: 'model_output'}},
    {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'partial'}},
    new Error('stream disconnected'),
  ));
  const {host} = fakeHost();
  await assert.rejects(
    streamStep(model, [{role: 'user', content: 'hello'}], [], host),
    (error: unknown) => {
      assert.ok(error instanceof StreamFailure);
      assert.equal(error.partial.content, 'partial');
      assert.equal(error.partial.continuation, undefined);
      return true;
    },
  );
});

test('a failed Gemini connection reports the retry before recovering', async () => {
  let attempts = 0;
  const model = choice(async () => {
    attempts += 1;
    if (attempts === 1) throw connectionError();
    return streamOf(
      {event_type: 'step.start', index: 0, step: {type: 'model_output'}},
      {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'Hello'}},
      {event_type: 'interaction.completed', interaction: {
        status: 'completed', usage: {total_input_tokens: 1, total_output_tokens: 1},
      }},
    );
  });
  const {host, events} = fakeHost();
  const response = await streamStep(model, [{role: 'user', content: 'hi'}], [], host, {
    sleep: async () => {},
  });
  assert.equal(response.content, 'Hello');
  assert.equal(attempts, 2);
  assert.deepEqual(events, [
    {type: 'model_retry', attempt: 2, total: 4},
    {type: 'text_delta', text: 'Hello'},
  ]);
});

test('a Gemini request that never connects times out without retrying', async () => {
  let attempts = 0;
  let suppliedSignal: AbortSignal | undefined;
  const model = choice(async (_request, signal) => {
    attempts += 1;
    suppliedSignal = signal;
    return new Promise<never>(() => {});
  });
  const {host, events} = fakeHost();
  await assert.rejects(
    streamStep(model, [{role: 'user', content: 'hi'}], [], host, {timeoutMs: 20}),
    ModelTimeoutError,
  );
  assert.equal(attempts, 1);
  assert.equal(suppliedSignal?.aborted, true);
  assert.deepEqual(events, []);
});

test('a Gemini stream that stalls after starting also times out', async () => {
  const model = choice(async () => ({
    async *[Symbol.asyncIterator]() {
      yield {event_type: 'step.start', index: 0, step: {type: 'model_output'}};
      await new Promise<never>(() => {});
    },
  }));
  const {host} = fakeHost();
  await assert.rejects(
    streamStep(model, [{role: 'user', content: 'hi'}], [], host, {timeoutMs: 20}),
    ModelTimeoutError,
  );
});

test('a timed-out Gemini stream keeps text already received', async () => {
  const model = choice(async (_request, signal) => ({
    async *[Symbol.asyncIterator]() {
      yield {event_type: 'step.start', index: 0, step: {type: 'model_output'}};
      yield {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'partial'} };
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {once: true}));
      throw new DOMException('cancelled', 'AbortError');
    },
  }));
  const {host} = fakeHost();
  await assert.rejects(
    streamStep(model, [{role: 'user', content: 'hi'}], [], host, {timeoutMs: 20}),
    (error: unknown) => {
      assert.ok(error instanceof StreamFailure);
      assert.equal(error.partial.content, 'partial');
      assert.ok(error.cause instanceof ModelTimeoutError);
      return true;
    },
  );
});

test('interruption settles a stalled Gemini request without showing a timeout', async () => {
  const controller = new AbortController();
  const model = choice(async () => new Promise<never>(() => {}));
  const {host} = fakeHost();
  host.signal = controller.signal;
  const pending = streamStep(model, [{role: 'user', content: 'hi'}], [], host, {timeoutMs: 1_000});
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
});

test('a non-streamed judge call uses the same stateless API', async () => {
  const requests: Record<string, unknown>[] = [];
  const client = geminiClient('test-key', async (sent) => {
    requests.push(sent);
    return {
      status: 'completed',
      steps: [{type: 'model_output', content: [{type: 'text', text: 'ALLOW'}]}],
      usage: {total_input_tokens: 12, total_output_tokens: 2, total_tokens: 14},
    };
  });
  const response = await client.chat.completions.create({
    model: 'gemini-3.8-flash', messages: [{role: 'user', content: 'Decide'}],
    max_tokens: 512, stream: false,
  });
  assert.equal(requests[0]?.store, false);
  assert.deepEqual(requests[0]?.tools, undefined);
  assert.equal(response.choices[0]?.message.content, 'ALLOW');
});

test('a saved session replays Gemini thought and tool steps after resume', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-work-'));
  try {
    const steps = [
      {type: 'thought', signature: 'persisted-signature'},
      {type: 'function_call', id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}},
    ];
    const assistant = assistantMessage('', [
      {id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}'},
    ], {kind: 'reasoning_content', content: GEMINI_STEPS_PREFIX + JSON.stringify(steps)});
    const store = startSession(work, home);
    store.appendStep([
      {role: 'user', content: 'read a.ts'}, assistant,
      {role: 'tool', tool_call_id: 'call-1', content: 'contents'},
    ], {prompt: 20, completion: 5, total: 30});
    store.close();
    const restored = loadSession(work, null, home);
    const request = interactionRequest({model: 'gemini-3.8-flash', messages: restored.messages});
    assert.deepEqual(request.input, [
      {type: 'user_input', content: [{type: 'text', text: 'read a.ts'}]},
      ...steps,
      {type: 'function_result', call_id: 'call-1', name: 'read_file', result: [{type: 'text', text: 'contents'}]},
    ]);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(work, {recursive: true, force: true});
  }
});
