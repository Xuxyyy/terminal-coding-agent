import {createHash} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import type {TaskCase} from './cases.js';

export const FIXTURE_PREFIX = 'acc-task-';
export const OVERLAY_DELETE_FILE = '.delete';

export type Changes = {added: string[]; modified: string[]; deleted: string[]};

export function buildFixture(c: TaskCase): string {
  const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  cpSync(join(c.dir, 'workspace'), root, {recursive: true});
  return root;
}

function walk(root: string, prefix: string, into: Map<string, string>): void {
  for (const entry of readdirSync(join(root, prefix), {withFileTypes: true})) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(root, relative, into);
    } else if (entry.isFile()) {
      into.set(relative, hashFile(join(root, relative)));
    }
  }
}

export function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function snapshot(root: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(root)) return found;
  walk(resolve(root), '', found);
  return new Map([...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function changes(
  before: Map<string, string>,
  after: Map<string, string>,
): Changes {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, hash] of after) {
    const was = before.get(path);
    if (was === undefined) added.push(path);
    else if (was !== hash) modified.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  return {added: added.sort(), modified: modified.sort(), deleted: deleted.sort()};
}

export type Overlay = 'solution' | 'counterexample';

function overlayDeletes(source: string): string[] {
  const manifest = join(source, OVERLAY_DELETE_FILE);
  if (!existsSync(manifest)) return [];
  return readFileSync(manifest, 'utf8')
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => {
      if (
        isAbsolute(path) ||
        /^[A-Za-z]:[\\/]/.test(path) ||
        path === '.' ||
        path.split(/[\\/]/).includes('..')
      ) {
        throw new Error(
          `${OVERLAY_DELETE_FILE} path '${path}' must stay inside the workspace`,
        );
      }
      return path;
    });
}

export function applyOverlay(c: TaskCase, root: string, overlay: Overlay): boolean {
  const source = join(c.dir, overlay);
  if (!existsSync(source)) return false;
  const manifest = join(source, OVERLAY_DELETE_FILE);
  const deletes = overlayDeletes(source);
  cpSync(source, root, {
    recursive: true,
    filter: (path) => path !== manifest,
  });
  for (const path of deletes) {
    rmSync(join(root, path), {recursive: true, force: true});
  }
  return true;
}

export function applySolution(c: TaskCase, root: string): void {
  applyOverlay(c, root, 'solution');
}

export function removeFixture(root: string): void {
  try {
    rmSync(root, {recursive: true, force: true});
  } catch {}
}
