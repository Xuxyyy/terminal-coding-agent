import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROTECTED_DIRECTORIES = new Set([
  '.git',
  '.claude',
  '.acc',
  '.vscode',
  '.idea',
  '.husky',
  '.devcontainer',
]);

const PROTECTED_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.pre-commit-config.yaml',
  '.mcp.json',
]);

export function realPath(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function expandUser(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

export function insideRoot(target: string, root: string): boolean {
  const relative = path.relative(realPath(root), realPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isProtectedPath(target: string, root: string): boolean {
  if (!insideRoot(target, root)) return true;
  const relative = path.relative(realPath(root), realPath(target));
  if (relative === '') return false;
  const parts = relative.split(path.sep);
  if (PROTECTED_FILES.has(parts[parts.length - 1])) return true;
  return parts.some((part) => PROTECTED_DIRECTORIES.has(part));
}
