import * as path from 'node:path';
import {expandUser} from '../permission/protected.js';

export function resolveTarget(root: string, target: string): string {
  return path.resolve(path.resolve(root), expandUser(target));
}

export function displayPath(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = resolveTarget(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return resolved;
  return relative || '.';
}
