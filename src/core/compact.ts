import type OpenAI from 'openai';
import {streamTurn, type ModelChoice} from './client.js';
import type {Host, Usage} from './host.js';
import {setMeasured, type Session} from './session.js';
import type {SessionStore} from './store.js';
import {estimateMessages} from './tokens.js';

type Message = OpenAI.ChatCompletionMessageParam;

export const SUMMARY_PREFIX =
  'Summary of the earlier conversation, which has been replaced by this note:\n\n';

export function compactionPrompt(): string {
  return [
    'Summarize this conversation so it can replace the messages above.',
    'Cover what the user is trying to do, what has been done so far,',
    'which files were touched and how, and what is still left.',
    'Keep every fact a later turn would need: paths, names, decisions.',
    'Write plain prose, not JSON, and address nothing to the user.',
  ].join(' ');
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
  const asked: Message[] = [
    ...session.messages,
    {role: 'user', content: compactionPrompt()},
  ];

  let text: string;
  let usage: Usage;
  try {
    const result = await streamTurn(choice, asked, [], host);
    text = result.content.trim();
    usage = result.usage;
  } catch {
    return null;
  }
  if (!text) return null;

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
