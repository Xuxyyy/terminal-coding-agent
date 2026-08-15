import type OpenAI from 'openai';
import {streamTurn, type ModelChoice} from './client.js';
import type {Host, Usage} from './host.js';
import {setMeasured, type Session} from './session.js';
import type {SessionStore} from './store.js';
import {estimateMessages} from './tokens.js';

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
): Promise<Compaction | null> {
  const usage: Usage = {prompt: 0, completion: 0, total: 0};
  let text: string | null = null;

  for (let attempt = 0; attempt < ATTEMPTS && text === null; attempt += 1) {
    const asked: Message[] = [
      ...session.messages,
      {role: 'user', content: compactionPrompt(attempt > 0)},
    ];
    try {
      const result = await streamTurn(choice, asked, [], host);
      usage.prompt += result.usage.prompt;
      usage.completion += result.usage.completion;
      usage.total += result.usage.total;
      text = summaryFrom(result.content);
    } catch {
      return null;
    }
  }
  if (text === null) return null;

  const before = estimateMessages(session.messages);
  const replaced = session.messages.filter(
    (message) => message.role !== 'system',
  ).length;
  const system: Message = session.messages.find(
    (message) => message.role === 'system',
  ) ?? {role: 'system', content: session.systemPrompt};
  const summary: Message = {role: 'assistant', content: SUMMARY_PREFIX + text};

  session.messages = [system, summary];
  setMeasured(session, 0);
  try {
    store?.appendCompact(summary, replaced);
  } catch {}

  return {
    summary: text,
    replaced,
    before,
    after: estimateMessages(session.messages),
    usage,
  };
}
