import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Item} from '../ui/events.js';
import type {Usage} from './host.js';

export type SessionMeta = {
  version: 1;
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
  view: Item[];
};

export type SessionStore = {
  id: string;
  dir: string;
  seed(messages: Message[]): void;
  appendTurn(messages: Message[], usage: Usage): void;
  appendView(items: Item[]): void;
  close(): void;
};

export const SESSION_MAX_AGE_DAYS = 30;
export const SESSION_KEEP = 50;

const DIR_MODE = 0o700;
const TURN_FILE = /^\d{4}\.json$/;
const VIEW_FILE = /^v\d{4}\.json$/;
const FIRST_TASK_MAX = 120;
type Entry = {dir: string; meta: SessionMeta};

export function accHome(): string {
  return process.env.ACC_HOME || path.join(os.homedir(), '.acc');
}

function makeDir(dir: string): void {
  fs.mkdirSync(dir, {recursive: true, mode: DIR_MODE});
  fs.chmodSync(dir, DIR_MODE);
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), {mode: 0o600});
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

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

export function projectDir(workspace: string, home: string = accHome()): string {
  const hash = crypto.createHash('sha256').update(workspace).digest('hex');
  const name = path.basename(workspace).replace(/[^\w.-]+/g, '-') || 'root';
  return path.join(home, 'projects', `${name}-${hash.slice(0, 8)}`);
}

function sessionsDir(workspace: string, home: string): string {
  return path.join(projectDir(workspace, home), 'sessions');
}

function byNewest(a: Entry, b: Entry): number {
  const key = (entry: Entry): string => `${entry.meta.startedAt} ${entry.meta.id}`;
  return key(a) < key(b) ? 1 : -1;
}

function entriesIn(dir: string): Entry[] {
  const found: Entry[] = [];
  for (const name of readDir(dir)) {
    const meta = readJson<SessionMeta>(path.join(dir, name, 'session.json'));
    if (meta) found.push({dir: path.join(dir, name), meta});
  }
  return found.sort(byNewest);
}

function allEntries(home: string): Entry[] {
  const root = path.join(home, 'projects');
  return readDir(root)
    .flatMap((name) => entriesIn(path.join(root, name, 'sessions')))
    .sort(byNewest);
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
    version: 1,
    id,
    workspace,
    startedAt: started.toISOString(),
    updatedAt: started.toISOString(),
    status: 'open',
    usage: {prompt: 0, completion: 0, total: 0},
  };
  return makeStore(dir, meta, 0, now);
}

function makeStore(
  dir: string,
  meta: SessionMeta,
  turns: number,
  now: () => Date,
): SessionStore {
  const written = new Set<Message>();

  const writeMeta = (): void => {
    meta.updatedAt = now().toISOString();
    writeJson(path.join(dir, 'session.json'), meta);
  };
  writeMeta();

  const nextFile = (prefix: string): string => {
    turns += 1;
    return path.join(dir, `${prefix}${String(turns).padStart(4, '0')}.json`);
  };

  return {
    id: meta.id,
    dir,
    seed(messages) {
      for (const message of messages) written.add(message);
    },
    appendTurn(messages, usage) {
      const fresh = messages.filter((message) => !written.has(message));
      if (fresh.length === 0) return;
      for (const message of fresh) written.add(message);
      if (meta.firstTask === undefined) meta.firstTask = firstTaskIn(fresh);
      writeJson(nextFile(''), fresh);
      meta.usage.prompt += usage.prompt;
      meta.usage.completion += usage.completion;
      meta.usage.total += usage.total;
      writeMeta();
    },
    appendView(items) {
      if (items.length === 0) return;
      writeJson(nextFile('v'), items);
      writeMeta();
    },
    close() {
      meta.status = 'closed';
      writeMeta();
    },
  };
}

export function listSessions(
  workspace: string,
  home: string = accHome(),
): SessionMeta[] {
  return entriesIn(sessionsDir(workspace, home)).map((entry) => entry.meta);
}

function messagesIn(dir: string): Message[] {
  return readDir(dir)
    .filter((name) => TURN_FILE.test(name))
    .sort()
    .flatMap((name) => readJson<Message[]>(path.join(dir, name)) ?? []);
}

function viewIn(dir: string): Item[] {
  return readDir(dir)
    .filter((name) => VIEW_FILE.test(name))
    .sort()
    .flatMap((name) => readJson<Item[]>(path.join(dir, name)) ?? []);
}

export function loadSession(
  workspace: string,
  id: string | null = null,
  home: string = accHome(),
): StoredSession {
  const entry = id
    ? allEntries(home).find((found) => found.meta.id === id)
    : entriesIn(sessionsDir(workspace, home))[0];

  if (!entry) {
    throw new Error(id ? `no session '${id}'` : `no session in ${workspace}`);
  }
  const owner = entry.meta.workspace;
  if (owner !== workspace) {
    throw new Error(`that session belongs to another folder: ${owner}`);
  }
  return {
    meta: entry.meta,
    messages: messagesIn(entry.dir),
    view: viewIn(entry.dir),
  };
}

function turnsIn(dir: string): number {
  let highest = 0;
  for (const name of readDir(dir)) {
    if (!TURN_FILE.test(name) && !VIEW_FILE.test(name)) continue;
    const turn = Number.parseInt(name.replace(/^v/, ''), 10);
    if (turn > highest) highest = turn;
  }
  return highest;
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
  return {stored, store: makeStore(dir, stored.meta, turnsIn(dir), now)};
}

export function evictSessions(
  home: string = accHome(),
  now: Date = new Date(),
  keep: number = SESSION_KEEP,
): number {
  const cutoff = now.getTime() - SESSION_MAX_AGE_DAYS * 86_400_000;
  const doomed = allEntries(home)
    .slice(keep)
    .filter((entry) => Date.parse(entry.meta.startedAt) < cutoff);

  for (const entry of doomed) {
    fs.rmSync(entry.dir, {recursive: true, force: true});
  }
  return doomed.length;
}
