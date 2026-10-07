import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';
import {startModelRelay} from '../../core/model-relay.js';
import {relayInvoke} from '../../core/model-relay-client.js';
import {geminiClient, interactionRequest} from '../../core/gemini.js';
import {judgeModelFor, streamStep} from '../../core/client.js';
import {askJudge} from '../../core/permission/judge.js';
import {fakeHost, streamOf} from '../fakes.js';

const model = 'gemini-3.8-flash';
const sentinel = 'fake-provider-secret-for-relay-test';
const request = () => interactionRequest({model, messages: [{role: 'user', content: 'Hi'}], stream: false});
const answer = {status: 'completed', steps: [{type: 'model_output', content: [{type: 'text', text: 'Hello'}]}]};
const endpoint = (relay: {port: number; path: string}) => `http://127.0.0.1:${relay.port}${relay.path}`;

test('a separate key-free ACC process gets model answers and its descendants have no provider key', async () => {
  const seen: unknown[] = [];
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 20, bindHost: '127.0.0.1',
    invoke: async (body) => { seen.push(body); return answer; }});
  try {
    const clientModule = new URL('../../core/client.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {createClient} from ${JSON.stringify(clientModule)};
      import {spawnSync} from 'node:child_process';
      const choice = createClient();
      const response = await choice.client.chat.completions.create({
        model: choice.model, messages: [{role: 'user', content: 'Hi'}], stream: false,
      });
      const shell = spawnSync('bash', ['--noprofile', '--norc', '-c',
        'test -z "$GEMINI_API_KEY$DEEPSEEK_API_KEY$MOONSHOT_API_KEY$TAVILY_API_KEY" && printf key-free']);
      console.log(JSON.stringify({answer: response.choices[0].message.content,
        shell: shell.stdout.toString(), status: shell.status}));
    `], {env: {PATH: process.env.PATH, ACC_MODEL_RELAY_URL: endpoint(relay), ACC_MODEL: model},
      stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {answer: 'Hello', shell: 'key-free', status: 0});
    assert.equal(JSON.stringify(seen).includes(sentinel), false);
    assert.equal(`${stdout}${stderr}`.includes(sentinel), false);
  } finally { await relay.close(); }
});

test('streamed tool calls and token usage survive the relay', async () => {
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async () => streamOf(
      {event_type: 'step.start', index: 0, step: {type: 'model_output'}},
      {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'Reading'}},
      {event_type: 'interaction.completed', interaction: {
        status: 'requires_action', steps: [{type: 'function_call', id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}}],
        usage: {total_input_tokens: 12, total_output_tokens: 3},
      }},
    )});
  try {
    const {host} = fakeHost();
    const result = await streamStep({client: geminiClient('', relayInvoke(endpoint(relay))),
      model, label: 'relay', contextWindow: 100_000}, [{role: 'user', content: 'Read'}], [], host);
    assert.equal(result.content, 'Reading');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}'}]);
    assert.equal(result.usage.prompt, 12);
    assert.equal(result.usage.completion, 3);
  } finally { await relay.close(); }
});

test('the relay uses Flash-Lite for permission judging and keeps the main model', async () => {
  const seen: unknown[] = [];
  const relay = await startModelRelay({apiKey: sentinel, model, maxSeconds: 10, bindHost: '127.0.0.1',
    invoke: async (body) => {
      seen.push(body.model);
      return body.model === model ? answer : {
        status: 'completed', steps: [{type: 'model_output', content: [{type: 'text', text: 'ALLOW'}]}],
      };
    }});
  try {
    const client = geminiClient('', relayInvoke(endpoint(relay)));
    const response = await client.chat.completions.create({
      model, messages: [{role: 'user', content: 'Hi'}], stream: false,
    });
    const verdict = await askJudge({client, model: judgeModelFor(model), label: 'judge', contextWindow: 1_048_576},
      [{role: 'user', content: 'Run the project tests'}], new AbortController().signal);

    assert.equal(response.choices[0]?.message.content, 'Hello');
    assert.equal(verdict, 'allow');
    assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
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
      {...request(), model: 'gemini-3.1-pro-preview'},
      {...request(), tools: [{type: 'google_search'}]},
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
