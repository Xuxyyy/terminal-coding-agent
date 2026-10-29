import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type OpenAI from 'openai';
import {modelSettings, type ModelSettings} from './client.js';
import {DEFAULT_MODEL} from './models.js';
import type {Usage} from './host.js';
import {transcriptStore} from './transcript-store.js';
import {
  lastUsageOf,
  liveRecords,
  messagesOf,
  readRecords,
  viewOf,
  type SessionRecord,
} from './records.js';
import {
  accHome,
  allEntries,
  entriesIn,
  isCurrent,
  makeDir,
  projectDir,
  SESSION_VERSION,
  sessionsDir,
  writeJson,
} from './projects.js';
import {acquireSessionLock, type SessionLock} from './session-lock.js';

export type SessionMeta = {
  version: number;
  id: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  status: 'open' | 'closed';
  usage: Usage;
  firstTask?: string;
  modelSettings?: ModelSettings;
};

type Message = OpenAI.ChatCompletionMessageParam;

export type StoredSession = {
  meta: SessionMeta;
  messages: Message[];
  view: unknown[];
  lastUsage: Usage | null;
};

export type SessionStore = {
  id: string;
  dir: string;
  seed(messages: Message[]): void;
  appendMessage(message: Message): string;
  appendStep(messages: Message[], usage: Usage): void;
  appendCompact(summary: Message, replaced: number, replacement: Message[]): void;
  appendView(items: unknown[]): void;
  appendCode(path: string, before: string | null): void;
  records(): SessionRecord[];
  rewind(to: number): void;
  close(): void;
};

const FIRST_TASK_MAX = 120;

function firstTaskIn(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, FIRST_TASK_MAX);
  }
  return undefined;
}

function stamp(when: Date): string {
  return when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export function startSession(
  workspace: string,
  home: string = accHome(),
  now: () => Date = () => new Date(),
  settings: ModelSettings = modelSettings({model: DEFAULT_MODEL}),
): SessionStore {
  const started = now();
  const id = `${stamp(started)}-${crypto.randomBytes(4).toString('hex')}`;
  const project = projectDir(workspace, home);
  const dir = path.join(project, 'sessions', id);

  makeDir(dir);
  makeDir(project);
  const lock = acquireSessionLock(dir);
  try {
    writeJson(path.join(project, 'project.json'), {path: workspace});

    const meta: SessionMeta = {
      version: SESSION_VERSION,
      modelSettings: settings,
      id,
      workspace,
      startedAt: started.toISOString(),
      updatedAt: started.toISOString(),
      status: 'open',
      usage: {prompt: 0, completion: 0, total: 0},
    };
    return makeStore(dir, meta, now, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

function makeStore(
  dir: string,
  meta: SessionMeta,
  now: () => Date,
  lock: SessionLock,
): SessionStore {
  const writeMeta = (messages: Message[] = [], usage?: Usage): void => {
    if (meta.firstTask === undefined) meta.firstTask = firstTaskIn(messages);
    if (usage) {
      meta.usage.prompt += usage.prompt;
      meta.usage.completion += usage.completion;
      meta.usage.total += usage.total;
    }
    meta.updatedAt = now().toISOString();
    writeJson(path.join(dir, 'session.json'), meta);
  };
  writeMeta();
  return transcriptStore(dir, meta.id, writeMeta, () => {
    try {
      meta.status = 'closed';
      writeMeta();
    } finally {
      lock.release();
    }
  });
}

export function loadSession(
  workspace: string,
  id: string | null = null,
  home: string = accHome(),
): StoredSession {
  const found = (
    id ? allEntries(home) : entriesIn(sessionsDir(workspace, home))
  ).filter((entry) => isCurrent(entry.meta));
  const entry = id ? found.find((one) => one.meta.id === id) : found[0];

  if (!entry) {
    throw new Error(id ? `no session '${id}'` : `no session in ${workspace}`);
  }
  const owner = entry.meta.workspace;
  if (owner !== workspace) {
    throw new Error(`that session belongs to another folder: ${owner}`);
  }
  const records = liveRecords(readRecords(entry.dir));
  return {
    meta: entry.meta,
    messages: messagesOf(records),
    view: viewOf(records),
    lastUsage: lastUsageOf(records),
  };
}

export function openSession(
  workspace: string,
  id: string | null = null,
  home: string = accHome(),
  now: () => Date = () => new Date(),
  settings?: ModelSettings,
): {stored: StoredSession; store: SessionStore} {
  const found = (
    id ? allEntries(home) : entriesIn(sessionsDir(workspace, home))
  ).filter((entry) => isCurrent(entry.meta));
  const entry = id ? found.find((one) => one.meta.id === id) : found[0];

  if (!entry) {
    throw new Error(id ? `no session '${id}'` : `no session in ${workspace}`);
  }
  const owner = entry.meta.workspace;
  if (owner !== workspace) {
    throw new Error(`that session belongs to another folder: ${owner}`);
  }

  if (entry.meta.modelSettings?.model !== DEFAULT_MODEL || entry.meta.modelSettings.provider !== 'deepseek') {
    throw new Error('this legacy session cannot resume with DeepSeek; start a fresh session with /clear');
  }
  const lock = acquireSessionLock(entry.dir);
  try {
    const records = liveRecords(readRecords(entry.dir));
    const stored: StoredSession = {
      meta: entry.meta,
      messages: messagesOf(records),
      view: viewOf(records),
      lastUsage: lastUsageOf(records),
    };
    stored.meta.status = 'open';
    if (settings) stored.meta.modelSettings = settings;
    return {stored, store: makeStore(entry.dir, stored.meta, now, lock)};
  } catch (error) {
    lock.release();
    throw error;
  }
}
