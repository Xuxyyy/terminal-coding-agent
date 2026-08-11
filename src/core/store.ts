import * as os from 'node:os';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Usage} from './host.js';

export type SessionMeta = {
  version: 1;
  id: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  status: 'open' | 'closed';
  usage: Usage;
};

export type StoredSession = {
  meta: SessionMeta;
  messages: OpenAI.ChatCompletionMessageParam[];
};

export type SessionStore = {
  id: string;
  dir: string;
  appendTurn(
    messages: OpenAI.ChatCompletionMessageParam[],
    usage: Usage,
  ): void;
  close(): void;
};

export const SESSION_MAX_AGE_DAYS = 30;
export const SESSION_KEEP = 50;

export function accHome(): string {
  return process.env.ACC_HOME || path.join(os.homedir(), '.acc');
}

export function projectDir(workspace: string, home: string = accHome()): string {
  throw new Error(`not implemented: projectDir(${workspace}, ${home})`);
}

export function startSession(
  workspace: string,
  home: string = accHome(),
  now: () => Date = () => new Date(),
): SessionStore {
  void now;
  throw new Error(`not implemented: startSession(${workspace}, ${home})`);
}

export function listSessions(
  workspace: string,
  home: string = accHome(),
): SessionMeta[] {
  throw new Error(`not implemented: listSessions(${workspace}, ${home})`);
}

export function loadSession(
  workspace: string,
  id: string | null = null,
  home: string = accHome(),
): StoredSession {
  void id;
  throw new Error(`not implemented: loadSession(${workspace}, ${home})`);
}

export function evictSessions(
  home: string = accHome(),
  now: Date = new Date(),
): number {
  void now;
  throw new Error(`not implemented: evictSessions(${home})`);
}
