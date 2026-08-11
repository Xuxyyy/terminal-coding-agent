import type OpenAI from 'openai';
import type {ContextStatus} from '../ui/events.js';
import type {Usage} from './host.js';

export type Session = {
  root: string;
  systemPrompt: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  allowed: Set<string>;
  usage: Usage;
  lastContextTokens: number;
  contextWindow: number;
};

export function createSession(
  root: string,
  systemPrompt: string,
  contextWindow: number,
): Session {
  return {
    root,
    systemPrompt,
    messages: [{role: 'system', content: systemPrompt}],
    allowed: new Set<string>(),
    usage: {prompt: 0, completion: 0, total: 0},
    lastContextTokens: 0,
    contextWindow,
  };
}

export function addTask(session: Session, task: string): void {
  session.messages.push({role: 'user', content: task});
}

export function recordUsage(session: Session, usage: Usage): void {
  session.usage.prompt += usage.prompt;
  session.usage.completion += usage.completion;
  session.usage.total += usage.total;
  if (usage.total) session.lastContextTokens = usage.total;
}

export function clearSession(session: Session): void {
  session.messages = [{role: 'system', content: session.systemPrompt}];
  session.lastContextTokens = 0;
}

export function contextStatus(session: Session): ContextStatus {
  return {used: session.lastContextTokens, budget: session.contextWindow};
}
