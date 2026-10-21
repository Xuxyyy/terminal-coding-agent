import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import {deepseekClient} from '../../core/deepseek.js';
import type {ModelChoice} from '../../core/client.js';
import {DEFAULT_MODEL} from '../../core/models.js';
import {runAgent} from '../../core/loop.js';
import {createSession} from '../../core/session.js';
import {loadSession, startSession} from '../../core/store.js';
import {writeFile} from '../../core/tools/write.js';
import {fakeHost, finishChunk, reasoningChunk, streamOf, textChunk, toolCallChunk, usageChunk} from '../fakes.js';

type Message = OpenAI.ChatCompletionMessageParam;

function model(next: (messages: Message[], nth: number) => AsyncIterable<unknown>): ModelChoice {
  let requests = 0;
  return {
    client: deepseekClient('', async (body) => next(body.messages as Message[], ++requests)),
    model: DEFAULT_MODEL,
    label: 'Fake DeepSeek',
    contextWindow: 1_048_576,
    reasoningEffort: 'high',
  };
}

test('recovery sends reasoning and unexecuted drafts before a complete replacement writes the file', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-output-limit-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-output-limit-home-'));
  const store = startSession(work, home);
  const active = createSession(work, 'rules', 1_048_576);
  const drafts = [
    {id: 'complete-looking', name: 'write_file', args: JSON.stringify({path: 'must-not-exist.txt', content: 'unexecuted'})},
    {id: 'cut-off', name: 'write_file', args: '{"path":"result.txt","content":"useful partial code'},
  ];
  const {host, events} = fakeHost();
  const sent: Message[][] = [];
  const choice = model((messages, nth) => {
    sent.push(structuredClone(messages));
    if (nth === 1) return streamOf(
      reasoningChunk('retain this plan'),
      textChunk('Preparing the file.'),
      toolCallChunk(drafts[0]!.id, drafts[0]!.name, drafts[0]!.args),
      toolCallChunk(drafts[1]!.id, drafts[1]!.name, drafts[1]!.args, 1),
      finishChunk('length'), usageChunk(10, 32_000),
    );
    if (nth === 2) {
      assert.equal(fs.existsSync(path.join(work, 'result.txt')), false);
      assert.equal(fs.existsSync(path.join(work, 'must-not-exist.txt')), false);
      assert.equal(events.some((event) => event.type === 'tool_start'), false);
      assert.equal(messages.some((message) => message.role === 'tool'), false);
      assert.equal(messages.some((message) => message.role === 'assistant' && message.tool_calls), false);
      const draft = messages.find((message) => message.role === 'assistant');
      assert.ok(draft && typeof draft.content === 'string');
      assert.match(draft.content, /Preparing the file\./);
      assert.match(draft.content, /drafts were not executed/);
      assert.deepEqual(JSON.parse(draft.content.slice(draft.content.lastIndexOf('\n') + 1)), drafts);
      assert.equal((draft as {reasoning_content?: string}).reasoning_content, 'retain this plan');
      assert.match(String(messages.at(-1)!.content), /complete valid tool call with all required arguments/);
      assert.deepEqual(loadSession(work, store.id, home).messages, active.messages.filter((message) => message.role !== 'system'));
      return streamOf(
        toolCallChunk('replacement', 'write_file', JSON.stringify({path: 'result.txt', content: 'complete replacement\n'})),
        finishChunk('tool_calls'), usageChunk(20, 10),
      );
    }
    return streamOf(textChunk('done'), finishChunk('stop'), usageChunk(30, 2));
  });

  try {
    await runAgent(active, choice, host, [writeFile], store);

    assert.equal(sent.length, 3);
    assert.equal(fs.readFileSync(path.join(work, 'result.txt'), 'utf8'), 'complete replacement\n');
    assert.equal(fs.existsSync(path.join(work, 'must-not-exist.txt')), false);
    assert.deepEqual(events.filter((event) => event.type === 'tool_start').map((event) => event.id), ['replacement']);
    assert.equal(events.some((event) => event.type === 'error' || event.type === 'model_retry'), false);
    const recovery = events.find((event) => event.type === 'recovery');
    const attempts = events.filter((event) => event.type === 'model_attempt');
    assert.ok(recovery?.type === 'recovery');
    assert.equal(recovery.kind, 'continuation');
    assert.equal(recovery.fromRequestId, attempts[0]!.evidence.requestId);
    assert.equal(recovery.requestId, attempts[1]!.evidence.requestId);
    assert.notEqual(recovery.fromRequestId, recovery.requestId);
    assert.deepEqual(attempts[0]!.evidence.partial, {
      content: 'Preparing the file.', toolCalls: drafts, reasoning: 'retain this plan',
    });
    assert.equal(attempts[0]!.evidence.outcome, 'incomplete');
    assert.deepEqual(active.usage, {prompt: 60, completion: 32_012, total: 32_072});
    assert.deepEqual(loadSession(work, store.id, home).messages, active.messages.filter((message) => message.role !== 'system'));
  } finally {
    store.close();
    fs.rmSync(work, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a reasoning-only interruption spends the existing allowance and the next tool draft is saved before stopping', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-output-limit-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-output-limit-home-'));
  const store = startSession(work, home);
  const active = createSession(work, 'rules', 1_048_576);
  const {host, events} = fakeHost();
  const sent: Message[][] = [];
  const choice = model((messages, nth) => {
    sent.push(structuredClone(messages));
    if (nth === 1) return streamOf(reasoningChunk('first plan'), finishChunk('length'));
    assert.ok(messages.some((message) => (message as {reasoning_content?: string}).reasoning_content === 'first plan'));
    return streamOf(
      reasoningChunk('second plan'),
      toolCallChunk('draft', 'write_file', '{"path":"result.txt","content":"partial'),
      finishChunk('length'),
    );
  });

  try {
    await runAgent(active, choice, host, [writeFile], store);

    assert.equal(sent.length, 2);
    assert.equal(fs.existsSync(path.join(work, 'result.txt')), false);
    assert.equal(events.some((event) => event.type === 'tool_start' || event.type === 'model_retry'), false);
    assert.equal(events.filter((event) => event.type === 'recovery' && event.kind === 'continuation').length, 1);
    assert.ok(events.some((event) => event.type === 'error' && /continuation exhausted/.test(event.message)));
    const saved = loadSession(work, store.id, home).messages;
    assert.deepEqual(saved, active.messages.filter((message) => message.role !== 'system'));
    assert.ok(saved.some((message) => message.role === 'assistant' && typeof message.content === 'string' && /partial/.test(message.content) && /drafts were not executed/.test(message.content)));
    assert.ok(saved.some((message) => (message as {reasoning_content?: string}).reasoning_content === 'second plan'));
    assert.equal(saved.some((message) => message.role === 'tool' || (message.role === 'assistant' && message.tool_calls)), false);
  } finally {
    store.close();
    fs.rmSync(work, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  }
});
