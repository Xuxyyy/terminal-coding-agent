import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Usage} from './host.js';
import {
  appendRecord,
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

export type SessionMeta = {
  version: number;
  id: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  status: 'open' | 'closed';
  usage: Usage;
  firstTask?: string;
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
  appendTurn(messages: Message[], usage: Usage): void;
  appendCompact(summary: Message, replaced: number): void;
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
): SessionStore {
  const started = now();
  const id = `${stamp(started)}-${crypto.randomBytes(4).toString('hex')}`;
  const project = projectDir(workspace, home);
  const dir = path.join(project, 'sessions', id);

  makeDir(dir);
  makeDir(project);
  writeJson(path.join(project, 'project.json'), {path: workspace});

  const meta: SessionMeta = {
    version: SESSION_VERSION,
    id,
    workspace,
    startedAt: started.toISOString(),
    updatedAt: started.toISOString(),
    status: 'open',
    usage: {prompt: 0, completion: 0, total: 0},
  };
  return makeStore(dir, meta, now);
}

function makeStore(dir: string, meta: SessionMeta, now: () => Date): SessionStore {
  const written = new Set<Message>();

  const writeMeta = (): void => {
    meta.updatedAt = now().toISOString();
    writeJson(path.join(dir, 'session.json'), meta);
  };
  writeMeta();

  return {
    id: meta.id,
    dir,
    seed(messages) {
      for (const message of messages) written.add(message);
    },
    appendMessage(message) {
      const id = crypto.randomBytes(4).toString('hex');
      written.add(message);
      if (meta.firstTask === undefined) meta.firstTask = firstTaskIn([message]);
      appendRecord(dir, {kind: 'message', id, message});
      writeMeta();
      return id;
    },
    appendTurn(messages, usage) {
      const fresh = messages.filter(
        (message) => message.role !== 'system' && !written.has(message),
      );
      if (fresh.length === 0) return;
      for (const message of fresh) written.add(message);
      if (meta.firstTask === undefined) meta.firstTask = firstTaskIn(fresh);
      appendRecord(dir, {kind: 'messages', messages: fresh, usage});
      meta.usage.prompt += usage.prompt;
      meta.usage.completion += usage.completion;
      meta.usage.total += usage.total;
      writeMeta();
    },
    appendCompact(summary, replaced) {
      written.add(summary);
      appendRecord(dir, {
        kind: 'compact',
        summary: typeof summary.content === 'string' ? summary.content : '',
        replaced,
      });
      writeMeta();
    },
    appendView(items) {
      if (items.length === 0) return;
      appendRecord(dir, {kind: 'view', items});
      writeMeta();
    },
    appendCode(path, before) {
      appendRecord(dir, {kind: 'code', path, before});
      writeMeta();
    },
    records() {
      return liveRecords(readRecords(dir));
    },
    rewind(to) {
      appendRecord(dir, {kind: 'rewind', to});
      writeMeta();
    },
    close() {
      meta.status = 'closed';
      writeMeta();
    },
  };
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
): {stored: StoredSession; store: SessionStore} {
  const stored = loadSession(workspace, id, home);
  const dir = path.join(sessionsDir(workspace, home), stored.meta.id);
  stored.meta.status = 'open';
  return {stored, store: makeStore(dir, stored.meta, now)};
}
