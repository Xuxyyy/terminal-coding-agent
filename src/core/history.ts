import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {makeDir} from './projects.js';
import type {SessionRecord} from './records.js';

const FILE_MODE = 0o600;

export function filesDir(sessionDir: string): string {
  return path.join(sessionDir, 'files');
}

export function captureBefore(sessionDir: string, target: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = filesDir(sessionDir);
  const copy = path.join(dir, sha);
  if (fs.existsSync(copy)) return sha;
  makeDir(dir);
  fs.writeFileSync(copy, bytes, {mode: FILE_MODE});
  return sha;
}

export function restorePlan(
  records: SessionRecord[],
  cut: number,
): Map<string, string | null> {
  const plan = new Map<string, string | null>();
  for (let at = Math.max(0, cut); at < records.length; at += 1) {
    const record = records[at];
    if (record?.kind !== 'code' || plan.has(record.path)) continue;
    plan.set(record.path, record.before);
  }
  return plan;
}
