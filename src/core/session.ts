import type OpenAI from 'openai';
import type {Usage} from './host.js';
import {estimateMessages, estimateTokens, estimateTools} from './tokens.js';
import {toolDefinitions, tools as defaultTools, type Tool} from './tools/index.js';

export type ContextStatus = {
  used: number;
  budget: number;
  measured: boolean;
  system: number;
  tools: number;
  conversation: number;
  free: number;
};

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

export function addTask(
  session: Session,
  task: string,
): OpenAI.ChatCompletionMessageParam {
  const message: OpenAI.ChatCompletionMessageParam = {role: 'user', content: task};
  session.messages.push(message);
  return message;
}

export function recordUsage(session: Session, usage: Usage): void {
  session.usage.prompt += usage.prompt;
  session.usage.completion += usage.completion;
  session.usage.total += usage.total;
  if (usage.total) session.lastContextTokens = usage.total;
}

export function rewindTo(session: Session, index: number): void {
  session.messages = session.messages.slice(0, Math.max(1, index));
  session.lastContextTokens = 0;
}

export function clearSession(session: Session): void {
  session.messages = [{role: 'system', content: session.systemPrompt}];
  session.allowed.clear();
  session.lastContextTokens = 0;
}

export function contextStatus(
  session: Session,
  registry: Tool[] = defaultTools,
): ContextStatus {
  const systemCost = estimateTokens(session.systemPrompt);
  const toolCost = estimateTools(toolDefinitions(registry));
  const talk = estimateMessages(
    session.messages.filter((message) => message.role !== 'system'),
  );
  const measured = session.lastContextTokens > 0;
  const used = measured ? session.lastContextTokens : systemCost + toolCost + talk;
  const system = Math.min(systemCost, used);
  const tools = Math.min(toolCost, used - system);
  return {
    used,
    budget: session.contextWindow,
    measured,
    system,
    tools,
    conversation: used - system - tools,
    free: Math.max(0, session.contextWindow - used),
  };
}
