import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {DEFAULT_MODE, type Mode} from './permission/mode.js';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv']);
const MAX_ENTRIES = 120;
const MAX_DEPTH = 2;

const INSTRUCTIONS = `You are a coding agent working in a real repository on the user's machine.

Work like a careful engineer:
- Read a file before you change it. Never guess at contents.
- Make the smallest change that fixes the problem, in the style of the surrounding code.
- Use grep to find where something lives, then read_file to see it. Do not read a
  whole file to look around.
- Use bash to run tests and to inspect git.
- After changing code, run the project's tests to prove the change works.
- Prefer edit_file over write_file for a file that already exists.
- edit_file needs old_string to appear exactly once, so include enough surrounding lines.

If the user greets you or asks something you can answer from what you already know, reply directly without calling a tool.

When a tool returns an error, read it and try a different approach; do not repeat the same call.
Stop and answer the user once the task is done. Keep your final answer short and concrete: what you changed and how you verified it.`;

export function fileTree(root: string): string {
  const lines: string[] = [];
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH || lines.length >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, {withFileTypes: true});
    } catch {
      return;
    }
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.') && !SKIP.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of visible) {
      if (lines.length >= MAX_ENTRIES) {
        lines.push(`${prefix}…`);
        return;
      }
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), `${prefix}  `, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return lines.join('\n');
}

export function environmentBlock(root: string): string {
  const isRepo = fs.existsSync(path.join(root, '.git'));
  return [
    '<environment>',
    `working directory: ${root}`,
    `platform: ${os.platform()} ${os.release()}`,
    `git repository: ${isRepo ? 'yes' : 'no'}`,
    '',
    'files:',
    fileTree(root),
    '</environment>',
  ].join('\n');
}

export function systemPrompt(root: string, mode: Mode = DEFAULT_MODE): string {
  return `${INSTRUCTIONS}\n\n${environmentBlock(root)}`;
}
