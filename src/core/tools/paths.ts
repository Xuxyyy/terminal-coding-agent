import * as fs from 'node:fs';
import * as path from 'node:path';

function escapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

export function resolveInWorkspace(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, target);
  if (escapes(base, resolved)) {
    throw new Error(`path is outside the workspace: ${target}`);
  }
  const existing = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
  if (fs.existsSync(existing)) {
    const real = fs.realpathSync(existing);
    if (real !== fs.realpathSync(base) && escapes(fs.realpathSync(base), real)) {
      throw new Error(`path escapes the workspace through a link: ${target}`);
    }
  }
  return resolved;
}

export function displayPath(root: string, target: string): string {
  return path.relative(path.resolve(root), target) || '.';
}
