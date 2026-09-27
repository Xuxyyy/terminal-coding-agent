import * as crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCK_FILE = 'session.lock';

type LockOwner = {
  pid: number;
  startedAt: string | null;
  token: string;
};

export type SessionLock = {
  release(): void;
};

export class SessionLockedError extends Error {
  constructor() {
    super('session is active elsewhere');
    this.name = 'SessionLockedError';
  }
}

function lockFile(dir: string): string {
  return path.join(dir, LOCK_FILE);
}

function processStartedAt(pid: number): string | null {
  try {
    const result = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

const THIS_PROCESS_STARTED_AT = processStartedAt(process.pid);

function isOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<LockOwner>;
  return (
    Number.isSafeInteger(owner.pid) &&
    Number(owner.pid) > 0 &&
    (owner.startedAt === null || typeof owner.startedAt === 'string') &&
    typeof owner.token === 'string' &&
    owner.token.length > 0
  );
}

function readOwner(file: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function ownerIsAlive(owner: LockOwner): boolean {
  if (!processExists(owner.pid)) return false;
  if (owner.startedAt === null) return true;
  const actual = processStartedAt(owner.pid);
  return actual === null || actual === owner.startedAt;
}

function retire(file: string): boolean {
  const retired = `${file}.stale-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(file, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    fs.unlinkSync(retired);
  } catch {}
  return true;
}

function existingLockIsActive(file: string): boolean {
  const owner = readOwner(file);
  if (owner === null) return true;
  if (ownerIsAlive(owner)) return true;
  retire(file);
  return fs.existsSync(file);
}

function placeLock(dir: string, owner: LockOwner): boolean {
  const file = lockFile(dir);
  const temporary = path.join(dir, `.session-lock-${owner.token}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(owner), {flag: 'wx', mode: 0o600});
    try {
      fs.linkSync(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

export function acquireSessionLock(dir: string): SessionLock {
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: THIS_PROCESS_STARTED_AT,
    token: crypto.randomBytes(16).toString('hex'),
  };
  const file = lockFile(dir);

  for (;;) {
    if (placeLock(dir, owner)) break;
    if (existingLockIsActive(file)) throw new SessionLockedError();
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = readOwner(file);
      if (current?.token !== owner.token) return;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function sessionIsLocked(dir: string): boolean {
  const file = lockFile(dir);
  if (!fs.existsSync(file)) return false;
  return existingLockIsActive(file);
}
