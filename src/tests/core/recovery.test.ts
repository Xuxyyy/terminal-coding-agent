import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as flush} from 'node:timers/promises';
import {z} from 'zod';
import {streamStep, ModelTimeoutError, StreamFailure} from '../../core/client.js';
import {errorCategory, isRetryable, RecoveryExhaustedError, retryDelay, withRetry} from '../../core/retry.js';
import {runAgent} from '../../core/loop.js';
import {createSession} from '../../core/session.js';
import {compactSession} from '../../core/compact.js';
import {runHeadless} from '../../core/headless/run.js';
import {runTool, type Tool} from '../../core/tools/registry.js';
import {connectionError, fakeHost, fakeModel, finishChunk, reasoningChunk, statusError, streamOf, textChunk, toolCallChunk, usageChunk} from '../fakes.js';

const fast = {sleep: async () => {}};

function interruptedConnection(): Error {
  return new Error('SDK request failed', {cause: new TypeError('terminated', {
    cause: Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'}),
  })});
}

test('nested socket interruptions before output use bounded request recovery', async () => {
  for (const phase of ['request', 'stream'] as const) {
    const error = Object.assign(interruptedConnection(), {headers: {'retry-after-ms': '25'}});
    const {choice, calls} = fakeModel((nth) => nth === 1
      ? phase === 'request' ? error : streamOf(error)
      : streamOf(textChunk('done'), finishChunk('stop')));
    const {host, events} = fakeHost();
    const waits: number[] = [];
    const result = await streamStep(choice, [], [], host, {sleep: async (ms) => { waits.push(ms); }});

    assert.equal(result.content, 'done');
    assert.equal(calls(), 2);
    assert.deepEqual(waits, [25]);
    assert.deepEqual(events.filter((event) => event.type === 'model_attempt').map((event) => [event.evidence.attempt, event.evidence.outcome, event.evidence.category]), [
      [1, 'failed', 'connection'], [2, 'completed', undefined],
    ]);
    const starts = events.filter((event) => event.type === 'model_attempt_start');
    assert.equal(starts[0]!.requestId, starts[1]!.requestId);
    assert.deepEqual(events.filter((event) => event.type === 'model_retry').map((event) => [event.attempt, event.total, event.delayMs]), [[2, 4, 25]]);
  }
});

test('repeated nested socket interruptions exhaust four attempts', async () => {
  const error = interruptedConnection();
  const {choice, calls} = fakeModel(() => streamOf(toolCallChunk('discard', 'bash', '{'), error));
  const {host, events} = fakeHost();
  const waits: number[] = [];
  await assert.rejects(streamStep(choice, [], [], host, {sleep: async (ms) => { waits.push(ms); }}), (caught) => {
    assert.ok(caught instanceof RecoveryExhaustedError);
    assert.equal(caught.attempts, 4);
    assert.ok(caught.cause instanceof StreamFailure);
    assert.equal(caught.cause.cause, error);
    assert.equal(errorCategory(caught), 'connection');
    return true;
  });
  assert.equal(calls(), 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(events.filter((event) => event.type === 'model_attempt').map((event) => event.evidence.category), Array(4).fill('connection'));
  assert.equal(events.filter((event) => event.type === 'model_retry').length, 3);
});

test('reasoning-only interruptions and mixed partial tool output retry the unchanged request', async () => {
  for (const parts of [
    [reasoningChunk('unfinished plan')],
    [reasoningChunk('unfinished plan'), textChunk('preparing a change'), toolCallChunk('draft', 'write_file', '{"path":')],
  ]) {
    const sent: unknown[] = [];
    const messages = [{role: 'user' as const, content: 'make the change'}];
    const {choice} = fakeModel((nth, body) => {
      sent.push(structuredClone(body));
      return nth === 1
        ? streamOf(...parts, interruptedConnection())
        : streamOf(textChunk('done'), finishChunk('stop'));
    });
    const {host, events} = fakeHost();

    const result = await streamStep(choice, messages, [], host, fast);

    assert.equal(result.content, 'done');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(messages, [{role: 'user', content: 'make the change'}]);
    assert.equal(events.filter((event) => event.type === 'model_retry').length, 1);
    assert.equal(events.some((event) => event.type === 'recovery' || event.type === 'tool_start'), false);
    const attempt = events.find((event) => event.type === 'model_attempt');
    assert.equal(attempt?.evidence.partial?.reasoning, 'unfinished plan');
  }
});

test('disabling transport retries preserves the original failure without an exhaustion wrapper', async () => {
  const error = interruptedConnection();
  const {choice, calls} = fakeModel(() => error);
  const {host, events} = fakeHost();

  await assert.rejects(streamStep(choice, [], [], host, {...fast, retries: 0}), (caught) => caught === error);

  assert.equal(calls(), 1);
  assert.equal(events.some((event) => event.type === 'model_retry'), false);
});

test('reasoning-only transport retries leave the invocation continuation available', async () => {
  const {choice, calls} = fakeModel((nth) => nth === 1
    ? streamOf(reasoningChunk('unfinished reasoning'), Object.assign(interruptedConnection(), {headers: {'retry-after-ms': '0'}}))
    : nth === 2
      ? streamOf(textChunk('unfinished answer'), finishChunk('length'))
      : streamOf(textChunk('done'), finishChunk('stop')));
  const session = createSession('/tmp', 'rules', 1_000_000);
  const {host, events} = fakeHost();

  await runAgent(session, choice, host, []);

  assert.equal(calls(), 3);
  assert.equal(events.filter((event) => event.type === 'model_retry').length, 1);
  assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'continuation').length, 1);
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.ok(session.messages.some((message) => message.role === 'assistant' && message.content === 'unfinished answer'));
  assert.equal(session.messages.some((message) => (message as {reasoning_content?: string}).reasoning_content === 'unfinished reasoning'), false);
});

test('a context error after the fourth transport attempt stops without compaction', async () => {
  const {choice, calls} = fakeModel((nth) => nth < 4
    ? Object.assign(interruptedConnection(), {headers: {'retry-after-ms': '0'}})
    : Object.assign(statusError(400, 'context length exceeded'), {code: 'context_length_exceeded'}));
  const {host, events} = fakeHost();

  await runAgent(createSession('/tmp', 'rules', 1_000_000), choice, host, []);

  assert.equal(calls(), 4);
  assert.equal(events.filter((event) => event.type === 'model_retry').length, 3);
  assert.equal(events.some((event) => event.type === 'compact_start' || event.type === 'recovery'), false);
  assert.ok(events.some((event) => event.type === 'error' && /context length exceeded/.test(event.message)));
});

test('a context failure after partial text uses context recovery rather than continuation', async () => {
  const {choice, calls} = fakeModel((nth, body) => {
    if (nth === 1) return streamOf(textChunk('attempt text'), Object.assign(statusError(400, 'context length exceeded'), {code: 'context_length_exceeded'}));
    const messages = (body as {messages: {role: string; content: string}[]}).messages;
    assert.equal(messages.some((message) => message.role === 'assistant' && message.content === 'attempt text'), false);
    return nth === 2
      ? streamOf(textChunk('The requested change remains pending. No file was changed. Inspect the current files before starting the implementation. '.repeat(2)), finishChunk('stop'))
      : streamOf(textChunk('done'), finishChunk('stop'));
  });
  const session = createSession('/tmp', 'rules', 1_000_000);
  session.messages.push({role: 'assistant', content: 'old details '.repeat(5000)});
  const {host, events} = fakeHost();

  await runAgent(session, choice, host, []);

  assert.equal(calls(), 3);
  assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'context').length, 1);
  assert.equal(events.some((event) => event.type === 'recovery' && event.kind === 'continuation'), false);
  assert.equal(events.some((event) => event.type === 'error' || event.type === 'model_retry'), false);
  const starts = events.filter((event) => event.type === 'model_attempt_start');
  assert.equal(starts[0]!.requestId, starts[2]!.requestId);
  assert.deepEqual([starts[0]!.attempt, starts[2]!.attempt], [1, 2]);
});

test('cancelling nested socket recovery prevents another model attempt', async () => {
  const {choice, calls} = fakeModel(() => interruptedConnection());
  const {host, controller, events} = fakeHost();
  await assert.rejects(streamStep(choice, [], [], host, {
    onRetry() { queueMicrotask(() => controller.abort()); },
  }), /aborted/i);
  assert.equal(calls(), 1);
  assert.equal(events.filter((event) => event.type === 'model_attempt_start').length, 1);
});

test('partial text from a nested socket interruption uses continuation without replay', async () => {
  const session = createSession('/tmp', 'rules', 1_000_000);
  const {choice, calls} = fakeModel((nth, body) => {
    if (nth === 1) return streamOf(textChunk('first part'), interruptedConnection());
    const messages = (body as {messages: {role: string; content: string}[]}).messages;
    assert.ok(messages.some((message) => message.role === 'assistant' && message.content === 'first part'));
    assert.match(messages.at(-1)!.content, /Continue from where it stopped/);
    return streamOf(textChunk('second part'), finishChunk('stop'));
  });
  const {host, events} = fakeHost();
  await runAgent(session, choice, host, []);
  assert.equal(calls(), 2);
  assert.equal(events.filter((event) => event.type === 'model_retry').length, 0);
  assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'continuation').length, 1);
  assert.deepEqual(session.messages.filter((message) => message.role === 'assistant').map((message) => message.content), ['first part', 'second part']);
});

function channel() {
  let receive: ((value: IteratorResult<unknown>) => void) | undefined;
  const source = {[Symbol.asyncIterator]() { return this; }, next: () => new Promise<IteratorResult<unknown>>((resolve) => { receive = resolve; })};
  return {source, push(value: unknown) { assert.ok(receive); const next = receive; receive = undefined; next({done: false, value}); }, end() { receive?.({done: true, value: undefined}); }};
}

test('meaningful reasoning and tool fragments keep a stream healthy beyond 120 seconds', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const feed = channel();
  const {choice} = fakeModel(() => feed.source);
  const {host, events} = fakeHost();
  const pending = streamStep(choice, [], [], host, {retries: 0});
  await flush();
  t.mock.timers.tick(119_000);
  feed.push(reasoningChunk('working'));
  await flush();
  t.mock.timers.tick(59_000);
  feed.push(toolCallChunk('one', 'bash', '{"command":'));
  await flush();
  t.mock.timers.tick(59_000);
  feed.push(toolCallChunk('', '', '"true"}'));
  await flush();
  feed.push(finishChunk('tool_calls'));
  await flush();
  feed.push(usageChunk(10, 20));
  await flush();
  feed.end();
  const response = await pending;
  assert.equal(response.toolCalls[0]!.args, '{"command":"true"}');
  assert.equal(events.some((event) => event.type === 'model_retry'), false);
});

for (const phase of ['startup', 'idle'] as const) {
  test(`empty chunks do not postpone the ${phase} timeout`, async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const feed = channel();
    const {choice} = fakeModel(() => feed.source);
    const {host} = fakeHost();
    const result = streamStep(choice, [], [], host, {retries: 0}).catch((error: unknown) => error);
    await flush();
    if (phase === 'idle') { feed.push(reasoningChunk('start')); await flush(); }
    t.mock.timers.tick(phase === 'startup' ? 119_000 : 59_000);
    feed.push(reasoningChunk(''));
    await flush();
    feed.push({choices: []});
    await flush();
    t.mock.timers.tick(1_000);
    const error = await result;
    const cause = error instanceof StreamFailure ? error.cause : error;
    assert.ok(cause instanceof ModelTimeoutError);
    assert.equal(cause.phase, phase);
    feed.end();
  });
}

test('valid completion ends generation even when the usage trailer never arrives', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const feed = channel();
  const {choice} = fakeModel(() => feed.source);
  const {host, events} = fakeHost();
  const pending = streamStep(choice, [], [], host, {retries: 0});
  await flush();
  feed.push(textChunk('done'));
  await flush();
  feed.push(finishChunk('stop'));
  await flush();
  t.mock.timers.tick(50);
  assert.equal((await pending).content, 'done');
  const attempt = events.find((event) => event.type === 'model_attempt');
  assert.equal(attempt?.evidence.usage, null);
  feed.end();
});

test('incomplete tool generation uses four attempts and never invents completion', async () => {
  const {choice, calls} = fakeModel(() => streamOf(toolCallChunk('one', 'bash', '{')));
  const {host, events} = fakeHost();
  await assert.rejects(streamStep(choice, [], [], host, fast), /valid completion/);
  assert.equal(calls(), 4);
  assert.equal(events.filter((event) => event.type === 'model_attempt').length, 4);
});

test('a complete invalid tool argument is returned to the model without execution', async () => {
  let executions = 0;
  const tool: Tool = {name: 'change', description: '', schema: z.object({value: z.string()}), async run() { executions++; return {text: 'changed'}; }};
  const {host} = fakeHost();
  const result = await runTool([tool], 'change', '{', {root: '/tmp', host, mode: 'auto-edits', allowed: new Set(), rules: {allow: [], ask: [], deny: []}});
  assert.equal(result.execution, 'not_started');
  assert.match(result.text, /valid JSON/);
  assert.equal(executions, 0);
});

test('failed tools preserve uncertain effects and completed tools are not replayed after a nested socket retry', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let executions = 0;
  const tool: Tool = {name: 'change', description: '', schema: z.object({}), async run() { executions++; throw new Error('failed after changing a file'); }};
  const session = createSession('/tmp', 'rules', 1_000_000);
  const {choice, calls} = fakeModel((nth, body) => {
    if (nth === 1) return streamOf(toolCallChunk('completed', 'change', '{}'), finishChunk('tool_calls'));
    const messages = (body as {messages: {role: string; content: string; tool_call_id?: string}[]}).messages;
    assert.ok(messages.some((message) => message.tool_call_id === 'completed' && /uncertain/.test(message.content)));
    if (nth === 2) return streamOf(toolCallChunk('incomplete', 'change', '{'), interruptedConnection());
    assert.ok(!messages.some((message) => message.tool_call_id === 'incomplete'));
    return streamOf(textChunk('I inspected the error'), finishChunk('stop'));
  });
  const {host} = fakeHost();
  const pending = runAgent(session, choice, host, [tool]);
  await flush();
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(calls(), 3);
  assert.equal(executions, 1);
});

test('text continuation for nested socket errors is separate from transport retries and cannot reset after tools', async () => {
  let executions = 0;
  const tool: Tool = {name: 'inspect', description: '', schema: z.object({}), async run() { executions++; return {text: 'seen'}; }};
  const session = createSession('/tmp', 'rules', 1_000_000);
  const {choice, calls} = fakeModel((nth) => nth === 2
    ? streamOf(toolCallChunk('one', 'inspect', '{}'), finishChunk('tool_calls'))
    : streamOf(textChunk('partial'), interruptedConnection()));
  const {host, events} = fakeHost();
  await runAgent(session, choice, host, [tool]);
  assert.equal(calls(), 3);
  assert.equal(executions, 1);
  assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'continuation').length, 1);
  const recovery = events.find((event) => event.type === 'recovery' && event.kind === 'continuation');
  assert.ok(recovery?.type === 'recovery');
  assert.ok(recovery.recoveryId);
  const starts = events.filter((event) => event.type === 'model_attempt_start');
  assert.equal(recovery.fromRequestId, starts[0]!.requestId);
  assert.equal(recovery.requestId, starts[1]!.requestId);
  assert.ok(events.some((event) => event.type === 'error' && /continuation exhausted/.test(event.message)));
});

test('context compaction preserves failure pairs and pending requests share the original attempt counter', async () => {
  const session = createSession('/tmp', 'rules', 1_000_000);
  session.messages.push({role: 'assistant', content: 'old details '.repeat(5000)});
  session.messages.push({role: 'assistant', content: '', tool_calls: [{id: 'bad', type: 'function', function: {name: 'bash', arguments: '{"command":"change"}'}}]});
  session.messages.push({role: 'tool', tool_call_id: 'bad', content: 'Error: failed\n[execution: uncertain]'});
  const {choice, calls} = fakeModel((nth, body) => {
    if (nth === 1) return Object.assign(statusError(400, 'context length exceeded'), {code: 'context_length_exceeded'});
    if (nth === 2) return streamOf(textChunk('The earlier command failed with uncertain effects. Inspect its outcome before any retry. '.repeat(2)), finishChunk('stop'));
    assert.ok(JSON.stringify(body).includes('execution: uncertain'));
    return streamOf(textChunk('finished'), finishChunk('stop'));
  });
  const {host, events} = fakeHost();
  await runAgent(session, choice, host, []);
  assert.equal(calls(), 3);
  const starts = events.filter((event) => event.type === 'model_attempt_start');
  assert.equal(starts[0]!.requestId, starts[2]!.requestId);
  assert.deepEqual([starts[0]!.attempt, starts[2]!.attempt], [1, 2]);
  assert.equal(session.messages.filter((message) => message.role === 'tool').length, 1);
});

test('repeated context errors compact once then stop', async () => {
  const session = createSession('/tmp', 'rules', 1_000_000);
  session.messages.push({role: 'assistant', content: 'old details '.repeat(5000)});
  const {choice, calls} = fakeModel((nth) => nth === 2
    ? streamOf(textChunk('Summary of earlier progress and remaining implementation work. '.repeat(3)), finishChunk('stop'))
    : Object.assign(statusError(400), {code: 'context_length_exceeded'}));
  const {host, events} = fakeHost();
  await runAgent(session, choice, host, []);
  assert.equal(calls(), 3);
  assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'context').length, 1);
  assert.ok(events.some((event) => event.type === 'error'));
});

test('authentication, credit exhaustion and unsupported configuration never retry', async () => {
  for (const error of [statusError(401), statusError(403), statusError(402), Object.assign(statusError(429), {code: 'insufficient_quota'}), statusError(400)]) {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw error; }, fast));
    assert.equal(calls, 1);
    assert.equal(isRetryable(error), false);
  }
  assert.equal(errorCategory(statusError(503)), 'temporary');
  assert.equal(retryDelay(Object.assign(statusError(429), {headers: {'retry-after': '12'}}), 0), 12_000);
  assert.equal(retryDelay(Object.assign(statusError(429), {headers: {'retry-after-ms': '25'}}), 0), 25);
});

test('an expired inherited deadline prevents the first request and evidence is delivered during execution', async () => {
  const {choice, calls} = fakeModel(() => streamOf(textChunk('done'), finishChunk('stop')));
  const expired = await runHeadless({root: '/tmp', task: 'test', choice, policy: 'deny', maxSeconds: 30, deadlineMs: Date.now() - 1});
  assert.equal(expired.stopped, 'timeout');
  assert.equal(calls(), 0);
  const delivered: string[] = [];
  const result = await runHeadless({root: '/tmp', task: 'test', choice, policy: 'deny', maxSeconds: 30, onEvent(event) { delivered.push(event.type); }});
  assert.ok(delivered.includes('model_attempt_start'));
  assert.equal(result.tokenUsage.complete, false);
  assert.equal(result.tokenUsage.attempts![0]!.usage, null);
});

test('usage reported before a failed tool stream is counted once across retries', async () => {
  const {choice} = fakeModel((nth) => nth === 1
    ? streamOf(toolCallChunk('discard', 'bash', '{'), usageChunk(10, 2), connectionError())
    : streamOf(textChunk('done'), finishChunk('stop'), usageChunk(20, 3)));
  const {host, modelUsage, events} = fakeHost();
  await streamStep(choice, [], [], host, fast);
  assert.equal(modelUsage.length, 2);
  assert.equal(modelUsage.reduce((sum, usage) => sum + usage.totalTokens, 0), 35);
  assert.deepEqual(events.filter((event) => event.type === 'model_attempt').map((event) => event.evidence.usage?.totalTokens), [12, 23]);
});

test('cancellation during retry backoff prevents a new request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = withRetry(async () => { calls++; throw statusError(503); }, {signal: controller.signal, onRetry() { queueMicrotask(() => controller.abort()); }});
  await assert.rejects(pending, /aborted/i);
  assert.equal(calls, 1);
});

test('late output after cancellation cannot execute tools or alter the conversation', async () => {
  const {host, controller, events} = fakeHost();
  let release!: (value: unknown) => void;
  const {choice} = fakeModel(() => new Promise((resolve) => { release = resolve; }));
  const pending = streamStep(choice, [], [], host, fast);
  await flush();
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  release(streamOf(textChunk('late'), toolCallChunk('late', 'bash', '{}'), finishChunk('tool_calls')));
  await flush();
  assert.equal(events.some((event) => event.type === 'text_delta' || event.type === 'tool_start'), false);
});

test('subagent requests inherit the main deadline and unknown usage is visible', async () => {
  let childRequests = 0;
  const {choice} = fakeModel((nth) => {
    if (nth === 1) return streamOf(toolCallChunk('child', 'agent', JSON.stringify({description: 'inspect', prompt: 'inspect'})), finishChunk('tool_calls'), usageChunk(10, 2));
    childRequests++;
    return new Promise(() => {});
  });
  const started = performance.now();
  const result = await runHeadless({root: '/tmp', task: 'test', choice, policy: 'deny', maxSeconds: 30, deadlineMs: Date.now() + 100});
  assert.equal(result.stopped, 'timeout');
  assert.equal(childRequests, 1);
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.tokenUsage.complete, false);
  assert.equal(result.tokenUsage.attempts!.length, 2);
  assert.equal(result.tokenUsage.attempts![0]!.agentId, 'main');
  assert.notEqual(result.tokenUsage.attempts![1]!.agentId, 'main');
});

test('stream API error codes retain recovery meaning without an HTTP status', () => {
  assert.equal(errorCategory({code: 'server_overloaded'}), 'temporary');
  assert.equal(errorCategory({type: 'server_error'}), 'temporary');
  assert.equal(errorCategory({type: 'rate_limit_error'}), 'rate_limit');
  assert.equal(errorCategory({code: 'invalid_api_key'}), 'authentication');
  assert.equal(isRetryable({type: 'server_error'}), true);
  assert.equal(isRetryable({code: 'invalid_api_key'}), false);
  assert.equal(retryDelay({headers: {'retry-after': '4'}, cause: connectionError()}, 0), 4000);
});

test('compaction does not retain successful reads merely because their content mentions errors', async () => {
  const session = createSession('/tmp', 'rules', 1_000_000);
  session.messages.push({role: 'assistant', content: '', tool_calls: [{id: 'good', type: 'function', function: {name: 'read_file', arguments: '{}'}}]});
  session.messages.push({role: 'tool', tool_call_id: 'good', content: 'Source: throw new Error: uncertain result'});
  const {choice} = fakeModel(() => streamOf(textChunk('The source was inspected successfully. Remaining work is to implement and verify the requested behavior. '.repeat(2)), finishChunk('stop')));
  const {host} = fakeHost();
  const result = await compactSession(session, choice, host);
  assert.ok(result);
  assert.equal(session.messages.some((message) => message.role === 'tool'), false);
});
