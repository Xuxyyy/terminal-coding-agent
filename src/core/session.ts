import type OpenAI from 'openai';
import type {Usage} from './host.js';
import type {Mode} from './permission/mode.js';
import {systemPrompt} from './prompt.js';
import {modeFor, rulesOf, type Rules} from './settings.js';
import {estimateMessages, estimateTokens, estimateTools} from './tokens.js';
import {toolDefinitions, toolsFor, type Tool} from './tools/index.js';

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
  rules: Rules;
  mode: Mode;
  usage: Usage;
  lastContextTokens: number;
  measuredAt: number;
  contextWindow: number;
  clearingExhausted: boolean;
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
    rules: rulesOf(),
    mode: modeFor(root),
    usage: {prompt: 0, completion: 0, total: 0},
    lastContextTokens: 0,
    measuredAt: 0,
    contextWindow,
    clearingExhausted: false,
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

export function setMeasured(session: Session, total: number): void {
  session.lastContextTokens = total;
  session.measuredAt = total > 0 ? estimateMessages(session.messages) : 0;
}

export function recordUsage(session: Session, usage: Usage): void {
  session.usage.prompt += usage.prompt;
  session.usage.completion += usage.completion;
  session.usage.total += usage.total;
  if (usage.total) setMeasured(session, usage.total);
}

export function restoreMessages(
  session: Session,
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  session.messages = [{role: 'system', content: session.systemPrompt}, ...messages];
  session.clearingExhausted = false;
  setMeasured(session, 0);
}

export function setMode(session: Session, mode: Mode): void {
  session.mode = mode;
  session.systemPrompt = systemPrompt(session.root, mode);
  session.messages = [
    {role: 'system', content: session.systemPrompt},
    ...session.messages.slice(1),
  ];
}

export function clearSession(session: Session): void {
  session.messages = [{role: 'system', content: session.systemPrompt}];
  session.allowed.clear();
  session.clearingExhausted = false;
  setMeasured(session, 0);
}

export function contextStatus(
  session: Session,
  registry: Tool[] = toolsFor(session.mode),
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

export function projectedTokens(
  session: Session,
  registry: Tool[] = toolsFor(session.mode),
): number {
  if (session.lastContextTokens === 0) return contextStatus(session, registry).used;
  const since = estimateMessages(session.messages) - session.measuredAt;
  return Math.max(0, session.lastContextTokens + since);
}

export const THRESHOLD_AT = 0.8;

export function contextThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ACC_COMPACT_AT;
  if (!raw) return THRESHOLD_AT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return THRESHOLD_AT;
  }
  return parsed;
}

export function overThreshold(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
  registry: Tool[] = toolsFor(session.mode),
): boolean {
  return (
    projectedTokens(session, registry) >=
    session.contextWindow * contextThreshold(env)
  );
}
