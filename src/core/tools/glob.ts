import {z} from 'zod';
import {INTERRUPTED} from '../host.js';
import {executable} from '../sandbox/policy.js';
import {runCommand} from '../sandbox/run.js';
import {displayPath, resolveTarget} from './paths.js';
import {pathVerdict} from '../permission/rules.js';
import {globWorker} from './glob-worker.js';
import {SEARCH_EXCLUSIONS} from './search.js';
import type {Tool} from './registry.js';

const MAX_FILES = 100;
const MAX_OUTPUT_CHARS = 32_000;
const NOTICE_RESERVE = 200;

const inputString = z.string().min(1).refine((value) => !value.includes('\0'), 'remove null bytes');
const schema = z.object({
  pattern: inputString
    .refine((value) => !value.startsWith('!') && !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'use a relative inclusion pattern; set path to choose the search directory')
    .describe('File glob relative to path, such as **/*.ts or src/**/*.{ts,tsx}. Supports *, **, ?, and braces.'),
  path: inputString.optional().describe('Existing directory to search, relative to the workspace or absolute. Defaults to the workspace.'),
});

export const glob: Tool = {
  name: 'glob',
  description:
    'Find files by name pattern. Returns up to 100 paths, newest first. Includes hidden and gitignored files but excludes sensitive files. Use grep to search contents.',
  schema,
  request(raw) {
    return {kind: 'read', path: schema.parse(raw).path ?? '.'};
  },
  async run(raw, ctx) {
    const args = schema.parse(raw);
    const program = executable('rg');
    if (!program) throw new Error('ripgrep (rg) is not on PATH, so glob cannot run. Use bash with find instead.');
    const result = await runCommand({
      root: ctx.root,
      sandbox: ctx.sandbox,
      program: process.execPath,
      args: ['--input-type=module', '--eval', `await (${globWorker.toString()})()`],
      input: JSON.stringify({target: resolveTarget(ctx.root, args.path ?? '.'), pattern: args.pattern, program, exclusions: SEARCH_EXCLUSIONS}),
      signal: ctx.host.signal,
      access: ctx.sandboxAccess,
      timeoutMs: 30_000,
    });
    if (result.interrupted) return {text: INTERRUPTED};
    if (result.timedOut) return {text: 'Error: search timed out after 30s; narrow pattern or path'};
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(`glob failed: ${result.stderr.trim() || 'worker did not return a result'}`);
    }
    const output = JSON.parse(result.stdout) as {files: Array<{name: string}>; skipped: boolean; error?: string};
    if (output.error) throw new Error(output.error);
    const files = output.files.filter((file) => pathVerdict(file.name, ctx.root, ctx.rules) !== 'deny');
    const lines: string[] = [];
    let size = 0;
    for (const file of files) {
      const name = displayPath(ctx.root, file.name);
      const line = /[\x00-\x1f\x7f]/.test(name) ? JSON.stringify(name) : name;
      if (lines.length === MAX_FILES || size + line.length + 1 > MAX_OUTPUT_CHARS - NOTICE_RESERVE) break;
      lines.push(line);
      size += line.length + 1;
    }
    const kept = lines.length;
    if (kept < files.length) lines.push(`... [truncated; showing ${kept} of ${files.length} files; narrow pattern or path]`);
    if (output.skipped) lines.push('[search incomplete: some paths could not be accessed]');
    return {text: lines.join('\n') || `no files matched glob '${args.pattern}'`};
  },
};
