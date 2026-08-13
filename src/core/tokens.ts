import type OpenAI from 'openai';
import type {ToolDefinition} from './tools/registry.js';

type Message = OpenAI.ChatCompletionMessageParam;

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const TOOL_CALL_OVERHEAD = 8;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function shapeTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

function partTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTokens(part);
  if (!part || typeof part !== 'object') return 0;
  const text = (part as {text?: unknown}).text;
  if (typeof text === 'string') return estimateTokens(text);
  return shapeTokens(part);
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (content === null || content === undefined) return 0;
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) total += partTokens(part);
    return total;
  }
  return shapeTokens(content);
}

function callTokens(call: unknown): number {
  if (!call || typeof call !== 'object') return TOOL_CALL_OVERHEAD;
  const fn = (call as {function?: {name?: unknown; arguments?: unknown}}).function;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
  return TOOL_CALL_OVERHEAD + estimateTokens(name) + estimateTokens(args);
}

export function estimateMessage(message: Message): number {
  if (!message || typeof message !== 'object') return 0;
  let total = MESSAGE_OVERHEAD + contentTokens((message as {content?: unknown}).content);
  const calls = (message as {tool_calls?: unknown}).tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) total += callTokens(call);
  }
  return total;
}

export function estimateMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessage(message);
  return total;
}

export function estimateTools(defs: readonly ToolDefinition[]): number {
  if (defs.length === 0) return 0;
  return shapeTokens(defs);
}
