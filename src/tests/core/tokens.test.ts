import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import {
  estimateMessage,
  estimateMessages,
  estimateTokens,
  estimateTools,
} from '../../core/tokens.js';
import {tools} from '../../core/tools/index.js';
import {toolDefinitions} from '../../core/tools/registry.js';

type Message = OpenAI.ChatCompletionMessageParam;

function calling(name: string, args: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_1', type: 'function', function: {name, arguments: args}}],
  };
}

test('an empty message list costs nothing', () => {
  assert.equal(estimateMessages([]), 0);
});

test('a message that only calls a tool still costs tokens', () => {
  const silent: Message = {role: 'assistant', content: null};
  const calls = calling('read_file', '{"path":"src/core/tokens.ts"}');

  assert.ok(estimateMessage(calls) > 0);
  assert.ok(estimateMessage(calls) > estimateMessage(silent));
});

test('array-shaped content costs the same as the plain string', () => {
  const parts: Message = {role: 'user', content: [{type: 'text', text: 'hello'}]};

  assert.equal(estimateMessage(parts), estimateMessage({role: 'user', content: 'hello'}));
  assert.ok(estimateMessage(parts) > 0);
});

test('the parts of a breakdown add up to the whole', () => {
  const a: Message = {role: 'system', content: 'you are a small coding agent'};
  const b = calling('bash', '{"command":"npm test"}');
  const c: Message = {role: 'tool', tool_call_id: 'call_1', content: '214 pass, 0 fail'};

  assert.equal(
    estimateMessages([a, b, c]),
    estimateMessage(a) + estimateMessage(b) + estimateMessage(c),
  );
});

test('four english characters cost one token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a small coding agent'), 5);
});

test('a chinese character costs a whole token, not a quarter', () => {
  assert.equal(estimateTokens('上下文用量'), 5);
  assert.equal(estimateTokens('こんにちは'), 5);
  assert.equal(estimateTokens('안녕하세요'), 5);
});

test('mixed text charges each script its own rate', () => {
  assert.equal(estimateTokens('hello 世界'), 4);
  assert.ok(estimateTokens('上下文用量') > estimateTokens('context'));
});

test('the four tool definitions cost several hundred tokens on every request', () => {
  const estimate = estimateTools(toolDefinitions(tools));

  assert.equal(estimateTools([]), 0);
  assert.ok(estimate > 260, `expected over 260 tokens, got ${estimate}`);
  assert.ok(estimate < 1_060, `expected under 1060 tokens, got ${estimate}`);
});
