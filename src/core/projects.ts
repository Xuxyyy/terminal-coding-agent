import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {SessionMeta} from './store.js';

export const SESSION_MAX_AGE_DAYS = 30;
export const SESSION_KEEP = 50;
export const SESSION_VERSION = 2;

export type Entry = {dir: string; meta: SessionMeta};

const DIR_MODE = 0o700;

export function accHome(): string {
  return process.env.ACC_HOME || path.join(os.homedir(), '.acc');
}

export function makeDir(dir: string): void {
  fs.mkdirSync(dir, {recursive: true, mode: DIR_MODE});
  fs.chmodSync(dir, DIR_MODE);
}

export function writeJson(file: string, value: unknown): void {
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

export function projectDir(workspace: string, home: string = accHome()): string {
  const hash = crypto.createHash('sha256').update(workspace).digest('hex');
  const name = path.basename(workspace).replace(/[^\w.-]+/g, '-') || 'root';
  return path.join(home, 'projects', `${name}-${hash.slice(0, 8)}`);
}

export function sessionsDir(workspace: string, home: string = accHome()): string {
  return path.join(projectDir(workspace, home), 'sessions');
}

export function isCurrent(meta: SessionMeta): boolean {
  return meta.version === SESSION_VERSION;
}

function byNewest(a: Entry, b: Entry): number {
  const key = (entry: Entry): string => `${entry.meta.startedAt} ${entry.meta.id}`;
  return key(a) < key(b) ? 1 : -1;
}

export function entriesIn(dir: string): Entry[] {
  const found: Entry[] = [];
  for (const name of readDir(dir)) {
    const meta = readJson<SessionMeta>(path.join(dir, name, 'session.json'));
    if (meta) found.push({dir: path.join(dir, name), meta});
  }
  return found.sort(byNewest);
}

export function allEntries(home: string): Entry[] {
  const root = path.join(home, 'projects');
  return readDir(root)
    .flatMap((name) => entriesIn(path.join(root, name, 'sessions')))
    .sort(byNewest);
}

export function listSessions(
  workspace: string,
  home: string = accHome(),
): SessionMeta[] {
  return entriesIn(sessionsDir(workspace, home))
    .map((entry) => entry.meta)
    .filter(isCurrent);
}

export function evictSessions(
  home: string = accHome(),
  now: Date = new Date(),
  keep: number = SESSION_KEEP,
): number {
  const cutoff = now.getTime() - SESSION_MAX_AGE_DAYS * 86_400_000;
  const doomed = allEntries(home)
    .slice(keep)
    .filter((entry) => Date.parse(entry.meta.updatedAt) < cutoff);

  for (const entry of doomed) {
    fs.rmSync(entry.dir, {recursive: true, force: true});
  }
  return doomed.length;
}
