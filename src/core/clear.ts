import type OpenAI from 'openai';
import {projectedTokens, type Session} from './session.js';
import {estimateMessages, estimateTokens} from './tokens.js';
import {tools as defaultTools, type Tool} from './tools/index.js';

type Message = OpenAI.ChatCompletionMessageParam;

export const CLEARED_READ =
  '[file contents cleared; read the file again if needed]';
export const CLEARED_OUTPUT = '[output cleared]';
export const CLEARED_SEARCH =
  '[search results cleared; run the same grep again if needed]';
export const CLEARED_CONTENT = '[cleared]';

type Call = {id?: unknown; function?: {name?: unknown; arguments?: unknown}};

function callsOf(message: Message): Call[] {
  const calls = (message as {tool_calls?: unknown}).tool_calls;
  return Array.isArray(calls) ? (calls as Call[]) : [];
}

function callNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of callsOf(message)) {
      const id = call.id;
      const name = call.function?.name;
      if (typeof id === 'string' && typeof name === 'string') names.set(id, name);
    }
  }
  return names;
}

function lastRoundAt(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && callsOf(message).length > 0) return index;
  }
  return messages.length;
}

function shrinks(before: string, after: string): boolean {
  return estimateTokens(after) < estimateTokens(before);
}

function clearedBash(content: string): string | null {
  const breakAt = content.indexOf('\n');
  if (!content.startsWith('[exit ') || breakAt < 0) return null;
  return `${content.slice(0, breakAt)}\n${CLEARED_OUTPUT}`;
}

function clearResult(message: Message, name: string | undefined): void {
  const content = (message as {content?: unknown}).content;
  if (typeof content !== 'string') return;
  const cleared =
    name === 'read_file'
      ? CLEARED_READ
      : name === 'grep'
        ? CLEARED_SEARCH
        : name === 'bash'
          ? clearedBash(content)
          : null;
  if (cleared === null || !shrinks(content, cleared)) return;
  (message as {content: string}).content = cleared;
}

function clearWrites(message: Message): void {
  for (const call of callsOf(message)) {
    if (call.function?.name !== 'write_file') continue;
    const args = call.function.arguments;
    if (typeof args !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const {path} = parsed as {path?: unknown};
    const cleared = JSON.stringify({path, content: CLEARED_CONTENT});
    if (!shrinks(args, cleared)) continue;
    call.function.arguments = cleared;
  }
}

export function clearRecoverable(
  session: Session,
  target: number,
  registry: Tool[] = defaultTools,
): number {
  const before = estimateMessages(session.messages);
  const names = callNames(session.messages);
  const limit = lastRoundAt(session.messages);

  for (let index = 0; index < limit; index += 1) {
    if (projectedTokens(session, registry) <= target) break;
    const message = session.messages[index];
    if (message.role === 'tool') {
      clearResult(message, names.get(message.tool_call_id));
      continue;
    }
    if (message.role === 'assistant') clearWrites(message);
  }

  return before - estimateMessages(session.messages);
}
