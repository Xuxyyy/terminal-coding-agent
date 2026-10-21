import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {deepseekClient, deepseekInvoke} from '../../core/deepseek.js';
import {chooseReasoning, createClient, createJudgeClient, modelSettings, streamStep, type ModelChoice} from '../../core/client.js';
import {DEFAULT_MODEL} from '../../core/models.js';
import {parseModel, parseReasoning} from '../../core/settings.js';
import {parseAgent} from '../../core/agents.js';
import {assistantMessage} from '../../core/messages.js';
import {startSession, openSession} from '../../core/store.js';
import {fakeHost, finishChunk, reasoningChunk, streamOf, textChunk, toolCallChunk, usageChunk} from '../fakes.js';

function choice(invoke: Parameters<typeof deepseekClient>[1], effort: ModelChoice['reasoningEffort'] = 'high'): ModelChoice {
  return {client: deepseekClient('', invoke), model: DEFAULT_MODEL, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, reasoningEffort: effort};
}

test('coding settings are explicit and reasoning overrides are validated', () => {
  assert.equal(chooseReasoning({}, null), 'high');
  assert.equal(chooseReasoning({}, 'low'), 'low');
  for (const effort of ['none', 'low', 'high', 'max'] as const) {
    assert.equal(chooseReasoning({ACC_REASONING_EFFORT: effort}, 'low'), effort);
    assert.equal(parseReasoning(JSON.stringify({reasoning_effort: effort}), 'settings.json', true), effort);
  }
  assert.throws(() => chooseReasoning({ACC_REASONING_EFFORT: 'medium'}), /none, low, high, or max/);
  assert.throws(() => chooseReasoning({ACC_REASONING_EFFORT: ''}), /none, low, high, or max/);
  assert.throws(() => parseReasoning('{"reasoning_effort":"low"}', 'project', false), /only read/);
  assert.throws(() => parseReasoning('{"reasoning_effort":5}', 'settings', true), /must be/);
  assert.deepEqual(modelSettings(choice(async () => null)), {
    provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash',
    reasoningEffort: 'high', thinking: 'enabled', maxOutputTokens: 32_000, requestTimeoutMs: 120_000, startupTimeoutMs: 120_000, idleTimeoutMs: 60_000,
  });
});

test('only the DeepSeek model is accepted for coding and judging', () => {
  assert.equal(parseModel(JSON.stringify({model: DEFAULT_MODEL}), 'settings.json', true), DEFAULT_MODEL);
  const agent = parseAgent(`---\ndescription: Inspect code\nmodel: ${DEFAULT_MODEL}\n---\nFind the bug.`, '/tmp/reviewer.md');
  assert.equal(agent.model, DEFAULT_MODEL);
  assert.throws(() => createClient('another-model'), /Unknown coding model/);
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try { assert.throws(() => createClient(DEFAULT_MODEL), /DEEPSEEK_API_KEY/); }
  finally { if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old; }
  process.env.DEEPSEEK_API_KEY = '';
  try { assert.throws(() => createJudgeClient(), /DEEPSEEK_API_KEY/); }
  finally { if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old; }
});

test('the SDK sends official DeepSeek requests and does not retry internally', async () => {
  const seen: {url: string; body: Record<string, unknown>}[] = [];
  const invoke = deepseekInvoke('fake-key', (async (url: unknown, init?: {body?: unknown}) => {
    seen.push({url: String(url), body: JSON.parse(String(init?.body))});
    return new Response(JSON.stringify({error: {message: 'test failure'}}), {status: 503, headers: {'content-type': 'application/json'}});
  }) as unknown as Parameters<typeof deepseekInvoke>[1]);
  await assert.rejects(invoke({model: DEFAULT_MODEL, messages: [], stream: false}));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen[0]!.body.model, DEFAULT_MODEL);
});

test('reasoning and fragmented tools survive later tool and user turns', async () => {
  const sent: Record<string, unknown>[] = [];
  const model = choice(async (request) => {
    sent.push(request);
    return sent.length === 1 ? streamOf(
      reasoningChunk('inspect '), reasoningChunk('the file'),
      toolCallChunk('call-1', 'read_file', '{"path":'),
      {choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: '"a.ts"}'}}]}, finish_reason: null}]},
      finishChunk('tool_calls'), usageChunk(12, 4, 3),
    ) : streamOf(reasoningChunk('continue'), textChunk('done'), finishChunk('stop'));
  });
  const {host, events} = fakeHost();
  const tool = {type: 'function' as const, function: {name: 'read_file', description: 'Read a file', parameters: {type: 'object'}}};
  const first = await streamStep(model, [{role: 'user', content: 'read a.ts'}], [tool], host);
  assert.deepEqual(first.toolCalls, [{id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}'}]);
  const assistant = assistantMessage(first.content, first.toolCalls, first.continuation);
  await streamStep(model, [assistant, {role: 'tool', tool_call_id: 'call-1', content: 'contents'}, {role: 'user', content: 'check again'}], [tool], host);
  assert.deepEqual((sent[1]!.messages as unknown[])[0], assistant);
  assert.equal((assistant as {reasoning_content?: string}).reasoning_content, 'inspect the file');
  assert.equal(sent[0]!.reasoning_effort, 'high');
  assert.deepEqual(sent[0]!.thinking, {type: 'enabled'});
  assert.equal(sent[0]!.max_tokens, 32_000);
  assert.equal(first.usage.total, 16);
  assert.deepEqual(events.filter((event) => event.type === 'text_delta'), [{type: 'text_delta', text: 'done'}]);
});

test('off and max reach the provider and tool-free requests omit tools', async () => {
  for (const effort of ['none', 'max'] as const) {
    let sent: Record<string, unknown> = {};
    const model = choice(async (request) => { sent = request; return streamOf(textChunk('ok'), finishChunk('stop')); }, effort);
    await streamStep(model, [{role: 'user', content: 'hello'}], [], fakeHost().host);
    assert.equal(sent.reasoning_effort, effort);
    assert.deepEqual(sent.thinking, {type: effort === 'none' ? 'disabled' : 'enabled'});
    assert.equal(sent.tools, undefined);
  }
});

test('truncated streams and failed finishes cannot execute partial tools', async () => {
  for (const parts of [
    [textChunk('partial')],
    [finishChunk('insufficient_system_resource')],
    [finishChunk('aborted')],
  ]) {
    const model = choice(async () => streamOf(...parts));
    await assert.rejects(streamStep(model, [{role: 'user', content: 'run'}], [], fakeHost().host));
  }
});

test('output-limited tools become unexecuted drafts without replaying the request', async () => {
  let requests = 0;
  const draft = {id: 'draft', name: 'write_file', args: '{"path":"result.txt","content":"part'};
  const model = choice(async () => {
    requests++;
    return streamOf(
      reasoningChunk('keep the useful plan'),
      textChunk('I will write the result.'),
      toolCallChunk(draft.id, draft.name, '{"path":"result.txt",'),
      {choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: '"content":"part'}}]}, finish_reason: 'length'}]},
      usageChunk(20, 32_000),
    );
  });
  const {host, events} = fakeHost();

  const response = await streamStep(model, [{role: 'user', content: 'write the result'}], [], host);

  assert.equal(requests, 1);
  assert.equal(response.finishReason, 'length');
  assert.equal(response.content, 'I will write the result.');
  assert.equal(response.continuation?.content, 'keep the useful plan');
  assert.deepEqual(response.toolCalls, []);
  assert.deepEqual(response.toolCallDrafts, [draft]);
  assert.equal(response.usage.completion, 32_000);
  assert.equal(events.some((event) => event.type === 'model_retry'), false);
  const attempt = events.find((event) => event.type === 'model_attempt');
  assert.equal(attempt?.evidence.outcome, 'incomplete');
  assert.deepEqual(attempt?.evidence.partial, {
    content: 'I will write the result.', toolCalls: [draft], reasoning: 'keep the useful plan',
  });
  assert.equal(attempt?.evidence.usage?.outputTokens, 32_000);
});

test('DeepSeek sessions retain reasoning and legacy sessions cannot resume', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-deepseek-session-'));
  const root = path.join(home, 'work');
  fs.mkdirSync(root);
  try {
    const settings = modelSettings(choice(async () => null, 'low'));
    const store = startSession(root, home, undefined, settings);
    const assistant = assistantMessage('answer', [], {kind: 'reasoning_content', content: 'saved reasoning'});
    store.appendStep([assistant], {prompt: 1, completion: 2, total: 3});
    store.close();
    const opened = openSession(root, store.id, home);
    assert.deepEqual(opened.stored.messages, [assistant]);
    assert.deepEqual(opened.stored.meta.modelSettings, settings);
    opened.store.close();
    const file = path.join(store.dir, 'session.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete meta.modelSettings;
    fs.writeFileSync(file, JSON.stringify(meta));
    assert.throws(() => openSession(root, store.id, home), /legacy session.*fresh session/);
    assert.equal(fs.existsSync(path.join(store.dir, 'session.jsonl')), true);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});


test('the official SDK carries explicit settings and parses DeepSeek SSE usage', async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_url: unknown, init?: {body?: unknown}) => {
    body = JSON.parse(String(init?.body));
    const chunks = [
      reasoningChunk('private reasoning'),
      textChunk('answer'),
      {choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {
        prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
        prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8,
      }},
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });
  }) as unknown as Parameters<typeof deepseekInvoke>[1];
  const model = choice(deepseekInvoke('test-key', fetch), 'max');
  const {host, modelUsage} = fakeHost();
  const result = await streamStep(model, [{role: 'user', content: 'hello'}], [], host);
  assert.equal(body.reasoning_effort, 'max');
  assert.deepEqual(body.thinking, {type: 'enabled'});
  assert.equal(body.max_tokens, 32_000);
  assert.equal(body.extra_body, undefined);
  assert.equal(result.content, 'answer');
  assert.equal(result.continuation?.content, 'private reasoning');
  assert.deepEqual(modelUsage, [{inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheHitInputTokens: 12, cacheMissInputTokens: 8}]);
});

test('SDK timeout leaves room for socket overhead and ACC owns cancellation', async () => {
  const controller = new AbortController();
  let observed: {signal?: AbortSignal; agent?: {options?: {timeout?: number}}; headers?: Record<string, string>} | undefined;
  const invoke = deepseekInvoke('fake-key', (async (_url: unknown, options: typeof observed) => {
    observed = options;
    return new Response(JSON.stringify({choices: [{message: {content: 'done'}}]}), {headers: {'content-type': 'application/json'}});
  }) as unknown as Parameters<typeof deepseekInvoke>[1]);
  await invoke({model: DEFAULT_MODEL, messages: [], stream: false}, controller.signal);
  assert.ok(observed?.signal);
  const timeout = observed?.agent?.options?.timeout;
  assert.ok(timeout && timeout > 120_000 && timeout <= 2_147_483_647);
  controller.abort();
  assert.equal(observed.signal.aborted, true);
});
