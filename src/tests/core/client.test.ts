import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelTokenUsage,
  StreamFailure,
  streamStep,
} from '../../core/client.js';
import {
  connectionError,
  fakeHost,
  fakeModel,
  finishChunk,
  reasoningChunk,
  statusError,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {AgentEvent} from '../../core/host.js';

const fast = {sleep: async () => {}};

function texts(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'text_delta' ? [event.text] : [],
  );
}

async function failureFrom(promise: Promise<unknown>): Promise<StreamFailure> {
  const result = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(result instanceof StreamFailure)) {
    assert.fail(`expected a StreamFailure, got ${String(result)}`);
  }
  return result;
}

test('a response collects the text, the tool calls and the usage', async () => {
  const {choice, calls} = fakeModel(() =>
    streamOf(
      textChunk('look'),
      reasoningChunk('plan '),
      reasoningChunk('the call'),
      textChunk('ing'),
      toolCallChunk('c1', 'read_file', '{"path":'),
      toolCallChunk('', '', '"a.js"}'),
      finishChunk('tool_calls'),
      usageChunk(120, 30),
    ),
  );
  const {host, events, modelUsage} = fakeHost();

  const response = await streamStep(choice, [], [], host, fast);

  assert.equal(response.content, 'looking');
  assert.deepEqual(response.continuation, {
    kind: 'reasoning_content',
    content: 'plan the call',
  });
  assert.equal(response.finishReason, 'tool_calls');
  assert.deepEqual(response.toolCalls, [
    {id: 'c1', name: 'read_file', args: '{"path":"a.js"}'},
  ]);
  assert.deepEqual(response.usage, {prompt: 120, completion: 30, total: 150});
  assert.deepEqual(modelUsage, [
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 120,
    },
  ]);
  assert.equal(calls(), 1);
  assert.deepEqual(texts(events), ['look', 'ing']);
  const thinking = events.filter((event) => event.type === 'thinking_delta');
  assert.deepEqual(thinking.map((event) => event.text), ['plan ', 'the call']);
  const start = events.find((event) => event.type === 'model_attempt_start')!;
  for (const event of thinking) {
    assert.equal(event.requestId, start.requestId);
    assert.equal(event.agentId, start.agentId);
    assert.equal(event.attempt, start.attempt);
  }
});

test('thinking is recorded before reply text without becoming reply text', async () => {
  const {choice} = fakeModel(() => streamOf(
    reasoningChunk('Inspect '), reasoningChunk('the result.'),
    textChunk('Done.'), finishChunk('stop'), usageChunk(12, 5),
  ));
  const {host, events} = fakeHost();
  host.agentId = 'worker';
  const response = await streamStep(choice, [], [], host, {...fast, requestId: 'thinking-request'});
  assert.equal(response.content, 'Done.');
  assert.deepEqual(response.continuation, {kind: 'reasoning_content', content: 'Inspect the result.'});
  assert.deepEqual(events.filter((event) => event.type === 'thinking_delta' || event.type === 'text_delta'), [
    {type: 'thinking_delta', text: 'Inspect ', requestId: 'thinking-request', agentId: 'worker', attempt: 1},
    {type: 'thinking_delta', text: 'the result.', requestId: 'thinking-request', agentId: 'worker', attempt: 1},
    {type: 'text_delta', text: 'Done.'},
  ]);
});

test('thinking from failed attempts stays attributed separately from retry output', async () => {
  const {choice} = fakeModel((nth) => nth === 1
    ? streamOf(reasoningChunk('Unfinished plan'), toolCallChunk('draft', 'read_file', '{'), connectionError())
    : streamOf(reasoningChunk('New plan'), textChunk('Done.'), finishChunk('stop')),
  );
  const {host, events} = fakeHost();
  const response = await streamStep(choice, [], [], host, {...fast, requestId: 'retry-request'});
  assert.equal(response.content, 'Done.');
  const thinking = events.filter((event) => event.type === 'thinking_delta');
  assert.deepEqual(thinking.map((event) => [event.requestId, event.attempt, event.text]), [
    ['retry-request', 1, 'Unfinished plan'], ['retry-request', 2, 'New plan'],
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'model_attempt').map((event) => event.evidence.outcome),
    ['failed', 'completed']);
});

test('standard cached-token details produce cache hit and miss usage', () => {
  assert.deepEqual(
    modelTokenUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: {cached_tokens: 80},
    }),
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheHitInputTokens: 80,
      cacheMissInputTokens: 40,
    },
  );
});

test('provider cache hit and miss fields are used directly', () => {
  assert.deepEqual(
    modelTokenUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: {cached_tokens: 1},
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 50,
    }),
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheHitInputTokens: 70,
      cacheMissInputTokens: 50,
    },
  );
});

test('a dropped connection before any output is retried', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth < 3
      ? connectionError()
      : streamOf(textChunk('hi'), finishChunk('stop'), usageChunk(10, 2)),
  );
  const {host, events} = fakeHost();

  const response = await streamStep(choice, [], [], host, fast);

  assert.equal(response.content, 'hi');
  assert.equal(calls(), 3);
  assert.deepEqual(texts(events), ['hi']);
});

test('a stream that dies before its first chunk is retried', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? streamOf(connectionError())
      : streamOf(textChunk('hi'), finishChunk('stop')),
  );
  const {host, events} = fakeHost();

  const response = await streamStep(choice, [], [], host, fast);

  assert.equal(response.content, 'hi');
  assert.equal(calls(), 2);
  assert.deepEqual(texts(events), ['hi']);
});

test('a dropped connection after output is not retried', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? streamOf(textChunk('half'), connectionError())
      : streamOf(textChunk('whole'), finishChunk('stop')),
  );
  const {host, events} = fakeHost();

  const failure = await failureFrom(streamStep(choice, [], [], host, fast));

  assert.equal(failure.partial.content, 'half');
  assert.equal(calls(), 1);
  assert.deepEqual(texts(events), ['half']);
});

test('a failed partial tool call is discarded and the request is retried', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? streamOf(toolCallChunk('c1', 'read_file', '{"path":'), connectionError())
      : streamOf(textChunk('whole'), finishChunk('stop')),
  );
  const {host} = fakeHost();

  const response = await streamStep(choice, [], [], host, fast);

  assert.equal(calls(), 2);
  assert.equal(response.content, 'whole');
  assert.deepEqual(response.toolCalls, []);
});

test('a bad request is not retried', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? statusError(400)
      : streamOf(textChunk('never'), finishChunk('stop')),
  );
  const {host} = fakeHost();

  await assert.rejects(streamStep(choice, [], [], host, fast), /status 400/);
  assert.equal(calls(), 1);
});
