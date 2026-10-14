import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';
import {startModelRelay} from '../../core/model-relay.js';
import {relayInvoke} from '../../core/model-relay-client.js';
import {deepseekClient} from '../../core/deepseek.js';
import {judgeModelFor, streamStep} from '../../core/client.js';
import {askJudge} from '../../core/permission/judge.js';
import {fakeHost, streamOf, textChunk, toolCallChunk, finishChunk, usageChunk} from '../fakes.js';

const model = 'deepseek-flash';
const sentinel = 'fake-provider-secret-for-relay-test';
const request = () => ({model, messages: [{role: 'user', content: 'Hi'}], stream: false, max_tokens: 32_000, reasoning_effort: 'high', thinking: {type: 'enabled'}});
const answer = {choices: [{message: {role: 'assistant', content: 'Hello'}, finish_reason: 'stop'}]};
const endpoint = (relay: {port: number; path: string}) => `http://127.0.0.1:${relay.port}${relay.path}`;

test('a separate key-free ACC process gets model answers and its descendants have no provider key', async () => {
  const seen: Record<string, unknown>[] = [];
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 20, bindHost: '127.0.0.1',
    invoke: async (body) => {
      seen.push(body);
      return body.max_tokens === 512
        ? {choices: [{message: {role: 'assistant', content: 'ALLOW'}, finish_reason: 'stop'}]}
        : answer;
    }});
  try {
    const clientModule = new URL('../../core/client.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {createClient, createJudgeClient} from ${JSON.stringify(clientModule)};
      import {spawnSync} from 'node:child_process';
      const choice = createClient();
      const response = await choice.client.chat.completions.create({
        model: choice.model, messages: [{role: 'user', content: 'Hi'}], stream: false,
      });
      const judge = createJudgeClient();
      const verdict = await judge.client.chat.completions.create({
        model: judge.model, messages: [{role: 'user', content: 'Decide'}], stream: false,
        max_tokens: 512,
      });
      const shell = spawnSync('bash', ['--noprofile', '--norc', '-c',
        'test -z "$DEEPSEEK_API_KEY$MOONSHOT_API_KEY$TAVILY_API_KEY" && printf key-free']);
      console.log(JSON.stringify({answer: response.choices[0].message.content,
        verdict: verdict.choices[0].message.content, judgeModel: judge.model,
        shell: shell.stdout.toString(), status: shell.status}));
    `], {env: {PATH: process.env.PATH, ACC_MODEL_RELAY_URL: endpoint(relay), ACC_MODEL: model},
      stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {answer: 'Hello', verdict: 'ALLOW', judgeModel: model, shell: 'key-free', status: 0});
    assert.deepEqual(seen.map((body) => body.model), [model, model]);
    assert.equal(JSON.stringify(seen).includes(sentinel), false);
    assert.equal(`${stdout}${stderr}`.includes(sentinel), false);
  } finally { await relay.close(); }
});

test('streamed tool calls and token usage survive the relay', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async () => streamOf(
      textChunk('Reading'),
      toolCallChunk('call-1', 'read_file', '{"path":"a.ts"}'),
      finishChunk('tool_calls'), usageChunk(12, 3),
    )});
  try {
    const {host} = fakeHost();
    const result = await streamStep({client: deepseekClient('', relayInvoke(endpoint(relay))),
      model, label: 'relay', contextWindow: 100_000}, [{role: 'user', content: 'Read'}], [], host);
    assert.equal(result.content, 'Reading');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}'}]);
    assert.equal(result.usage.prompt, 12);
    assert.equal(result.usage.completion, 3);
  } finally { await relay.close(); }
});

test('the relay uses DeepSeek for coding and permission judging', async () => {
  const seen: Record<string, unknown>[] = [];
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async (body) => {
      seen.push(body);
      return body.max_tokens === 512
        ? {choices: [{message: {role: 'assistant', content: 'ALLOW'}, finish_reason: 'stop'}]}
        : answer;
    }});
  try {
    const client = deepseekClient('', relayInvoke(endpoint(relay)));
    const response = await client.chat.completions.create({
      model, messages: [{role: 'user', content: 'Hi'}], stream: false,
    });
    const verdict = await askJudge({client: deepseekClient('', relayInvoke(endpoint(relay))), model: judgeModelFor(model), label: 'judge', contextWindow: 1_048_576},
      [{role: 'user', content: 'Run the project tests'}], new AbortController().signal);

    assert.equal(response.choices[0]?.message.content, 'Hello');
    assert.equal(verdict, 'allow');
    assert.deepEqual(seen.map((body) => body.model), [model, model]);
    assert.equal(seen[1]?.max_tokens, 512);
    assert.equal(seen[1]?.stream, false);
  } finally { await relay.close(); }
});

test('the relay rejects unknown routes, other models, built-in tools and excessive token limits', async () => {
  let invoked = 0;
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async () => { invoked += 1; return answer; }});
  try {
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/key`)).status, 404);
    for (const body of [
      {...request(), model: 'another-model'},
      {...request(), model: 'other-provider-model'},
      {...request(), tools: [{type: 'external_search'}]},
      {...request(), generation_config: {max_output_tokens: 100_000}},
      {...request(), url: 'https://another-host.example'},
      {...request(), store: true},
    ]) {
      const result = await fetch(endpoint(relay), {method: 'POST', body: JSON.stringify(body)});
      assert.equal(result.status, 400);
      assert.equal((await result.text()).includes(sentinel), false);
    }
    assert.equal(invoked, 0);
  } finally { await relay.close(); }
});

test('trial quotas and cleanup revoke the temporary model capability', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, maxRequests: 1,
    bindHost: '127.0.0.1', invoke: async () => answer});
  const send = () => fetch(endpoint(relay), {method: 'POST', body: JSON.stringify(request())});
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  await relay.close();
  await assert.rejects(send());
  await relay.close();
});

test('provider errors do not expose their text or credentials', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async () => { throw new Error(sentinel); }});
  try {
    const response = await fetch(endpoint(relay), {method: 'POST', body: JSON.stringify(request())});
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(sentinel), false);
  } finally { await relay.close(); }
});

test('provider stream error events are sanitized too', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async () => streamOf(
      {event_type: 'step.start', index: 0, step: {type: 'model_output'}},
      {event_type: 'error', error: {message: sentinel}},
    )});
  try {
    const response = await fetch(endpoint(relay), {method: 'POST', body: JSON.stringify({...request(), stream: true})});
    const text = await response.text();
    assert.equal(text.includes(sentinel), false);
    assert.ok(text.includes('"error":true'));
  } finally { await relay.close(); }
});

test('disconnecting from the relay aborts the provider request', async () => {
  let started!: () => void;
  let aborted!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const abort = new Promise<void>((resolve) => { aborted = resolve; });
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async (_body, signal) => {
      started();
      return new Promise((_, reject) => signal!.addEventListener('abort', () => {
        aborted(); reject(new Error('cancelled'));
      }, {once: true}));
    }});
  try {
    const controller = new AbortController();
    const response = fetch(endpoint(relay), {method: 'POST', body: JSON.stringify(request()), signal: controller.signal});
    await start;
    controller.abort();
    await assert.rejects(response);
    await abort;
  } finally { await relay.close(); }
});

test('a truncated relay stream fails instead of reporting completion', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/x-ndjson');
    response.end('{"event":{"event_type":"step.start"}}\n');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as {port: number};
  try {
    const stream = await relayInvoke(`http://127.0.0.1:${address.port}`)({...request(), stream: true});
    await assert.rejects(async () => { for await (const _ of stream as AsyncIterable<unknown>) {} }, /ended early/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('relay access expires even if its owner forgets to close it', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 1, bindHost: '127.0.0.1',
    invoke: async () => answer});
  try {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await assert.rejects(fetch(endpoint(relay), {method: 'POST', body: JSON.stringify(request())}));
  } finally { await relay.close(); }
});
