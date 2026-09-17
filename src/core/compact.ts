import type OpenAI from 'openai';
import {streamStep, type ModelChoice} from './client.js';
import type {Host, Usage} from './host.js';
import {assistantMessage, type AssistantContinuation} from './messages.js';
import {setMeasured, type Session} from './session.js';
import type {SessionStore} from './store.js';
import {estimateMessage, estimateMessages} from './tokens.js';

type Message = OpenAI.ChatCompletionMessageParam;

export const SUMMARY_PREFIX =
  'Summary of the earlier conversation, which has been replaced by this note:\n\n';

export function compactionPrompt(strict = false): string {
  const lines = [
    'Summarize this conversation so it can replace the messages above.',
    'Cover what the user is trying to do, what has been done so far,',
    'which files were touched and how, and what is still left.',
    'Keep every fact a later turn would need: paths, names, decisions.',
    'Write plain prose, not JSON, and address nothing to the user.',
  ];
  if (strict) {
    lines.push(
      'Reply with prose only. Do not call a tool and do not answer any earlier request.',
    );
  }
  return lines.join(' ');
}

const TOOL_MARKUP = /<\||<｜|<tool_call|<function_call|invoke name=/i;

export const MIN_SUMMARY = 120;

export const ATTEMPTS = 2;

export const RETAINED_USER_PROMPT_BUDGET = 20_000;

const TRUNCATED_USER_PROMPT =
  '[Earlier content truncated during compaction]\n\n';

function truncatedUserPrompt(
  message: Message,
  budget: number,
): Message | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null;

  const content = message.content;
  let low = 0;
  let high = Math.max(0, content.length - 1);
  let result: Message | null = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate: Message = {
      ...message,
      content: TRUNCATED_USER_PROMPT + content.slice(content.length - length),
    };
    if (estimateMessage(candidate) <= budget) {
      result = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return result;
}

export function retainRecentUserPrompts(
  messages: readonly Message[],
  budget = RETAINED_USER_PROMPT_BUDGET,
): Message[] {
  const retained: Message[] = [];
  let used = 0;

  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.role !== 'user') continue;

    const cost = estimateMessage(message);
    if (used + cost <= budget) {
      retained.push(message);
      used += cost;
      continue;
    }
    if (typeof message.content !== 'string') continue;

    const truncated = truncatedUserPrompt(message, budget - used);
    if (truncated) {
      retained.push(truncated);
      break;
    }
  }

  return retained.reverse();
}

export function summaryFrom(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SUMMARY) return null;
  if (TOOL_MARKUP.test(trimmed)) return null;
  return trimmed;
}

export function withoutText(host: Host): Host {
  return {
    signal: host.signal,
    confirm: (request) => host.confirm(request),
    onEvent: (event) => {
      if (event.type !== 'text_delta') host.onEvent(event);
    },
  };
}

export type Compaction = {
  summary: string;
  replaced: number;
  before: number;
  after: number;
  usage: Usage;
};

export async function compactSession(
  session: Session,
  choice: ModelChoice,
  host: Host,
  store?: SessionStore,
  postSummaryMessages: readonly Message[] = [],
): Promise<Compaction | null> {
  const usage: Usage = {prompt: 0, completion: 0, total: 0};
  let text: string | null = null;
  let continuation: AssistantContinuation | undefined;

  for (let attempt = 0; attempt < ATTEMPTS && text === null; attempt += 1) {
    const asked: Message[] = [
      ...session.messages,
      {role: 'user', content: compactionPrompt(attempt > 0)},
    ];
    try {
      const result = await streamStep(choice, asked, [], host);
      usage.prompt += result.usage.prompt;
      usage.completion += result.usage.completion;
      usage.total += result.usage.total;
      text = summaryFrom(result.content);
      if (text !== null) continuation = result.continuation;
    } catch {
      return null;
    }
  }
  if (text === null) return null;

  const before = estimateMessages([...session.messages, ...postSummaryMessages]);
  const replaced = session.messages.filter(
    (message) => message.role !== 'system',
  ).length;
  const system: Message = session.messages.find(
    (message) => message.role === 'system',
  ) ?? {role: 'system', content: session.systemPrompt};
  const retainedUsers = retainRecentUserPrompts(session.messages);
  const summary = assistantMessage(SUMMARY_PREFIX + text, [], continuation);
  const replacement = [...retainedUsers, summary, ...postSummaryMessages];

  session.messages = [system, ...replacement];
  setMeasured(session, 0);
  try {
    store?.appendCompact(summary, replaced, replacement);
  } catch {}

  return {
    summary: text,
    replaced,
    before,
    after: estimateMessages(session.messages),
    usage,
  };
}
