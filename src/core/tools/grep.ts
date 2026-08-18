import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {z} from 'zod';
import type {Tool} from './registry.js';
import {resolveInWorkspace} from './paths.js';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 32_000;

const STATS =
  /\n*(\d+) matches\n\d+ matched lines\n(\d+) files contained matches\n(\d+) files searched\n[\s\S]*$/;

const MISSING_RG =
  'ripgrep (rg) is not on PATH, so grep cannot run. Use bash with grep -rn instead.';

type Stats = {matches: number; files: number; searched: number};

export function splitStats(stdout: string): {body: string; stats: Stats | null} {
  const found = STATS.exec(stdout);
  if (!found) return {body: stdout.trimEnd(), stats: null};
  return {
    body: stdout.slice(0, found.index).trimEnd(),
    stats: {
      matches: Number(found[1]),
      files: Number(found[2]),
      searched: Number(found[3]),
    },
  };
}

export function stripHere(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.startsWith('./') ? line.slice(2) : line))
    .join('\n');
}

export function capSearch(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + (kept.length === 0 ? 0 : 1);
    if (next > MAX_OUTPUT_CHARS) break;
    kept.push(line);
    size = next;
  }
  return (
    kept.join('\n') +
    `\n... [truncated ${text.length - size} chars, cap is ${MAX_OUTPUT_CHARS};` +
    ' narrow with glob or path]'
  );
}

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for, in ripgrep syntax.'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search, relative to the workspace root. Defaults to the whole workspace.'),
  glob: z
    .string()
    .optional()
    .describe("Only search files matching this glob, such as '*.ts' or 'src/**/*.md'."),
  output_mode: z
    .enum(['files_with_matches', 'content', 'count'])
    .optional()
    .describe(
      'files_with_matches returns matching paths only and is the default; content returns the matching lines with line numbers; count returns how many matches each file holds.',
    ),
  case_insensitive: z.boolean().optional().describe('Ignore case. Defaults to false.'),
  context: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Lines of context around each match. Only used when output_mode is content.'),
});

type Args = z.infer<typeof schema>;

type Run = {code: number; stdout: string; stderr: string};

function flagsFor(args: Args): string[] {
  const mode = args.output_mode ?? 'files_with_matches';
  if (mode === 'count') return ['-c'];
  if (mode === 'content') {
    return args.context === undefined ? ['-n'] : ['-n', '-C', String(args.context)];
  }
  return ['-l'];
}

function argv(args: Args, target: string): string[] {
  const flags = ['--stats', '--no-require-git', '--hidden', ...flagsFor(args)];
  if (args.case_insensitive) flags.push('-i');
  if (args.glob) flags.push('--glob', args.glob);
  flags.push('--glob', '!.git', '--regexp', args.pattern, target);
  return flags;
}

function ripgrep(args: string[], cwd: string, signal: AbortSignal): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, {
      cwd,
      signal,
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(MISSING_RG));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      resolve({code: code === null ? 124 : code, stdout, stderr});
    });
  });
}

function nothingFound(args: Args, stats: Stats | null, where: string): string {
  if (stats && stats.searched === 0) {
    return args.glob
      ? `no files matched glob '${args.glob}'`
      : `no files to search in '${where}'`;
  }
  return `no matches — searched ${stats?.searched ?? 0} files`;
}

export const grep: Tool = {
  name: 'grep',
  description:
    'Search file contents in the workspace with ripgrep. Returns matching file paths by default, so use it to find where something lives and then read_file to see it. Respects .gitignore.',
  schema,
  async run(rawArguments, ctx) {
    const args = schema.parse(rawArguments);
    const where = args.path ?? '.';
    const resolved = resolveInWorkspace(ctx.root, where);
    if (!fs.existsSync(resolved)) {
      throw new Error(`path not found: ${where}`);
    }
    const relative = path.relative(path.resolve(ctx.root), resolved);
    const run = await ripgrep(argv(args, relative || '.'), ctx.root, ctx.host.signal);
    if (run.code === 124) {
      return {text: `search timed out after ${TIMEOUT_MS / 1000}s; narrow it with glob or path`};
    }
    const {body, stats} = splitStats(stripHere(run.stdout));
    if (stats && stats.searched === 0) {
      return {text: nothingFound(args, stats, where)};
    }
    if (run.code === 2) {
      return {text: `invalid pattern: ${run.stderr.trim() || 'ripgrep exited 2'}`};
    }
    if (run.code === 1 || body === '') {
      return {text: nothingFound(args, stats, where)};
    }
    if (args.output_mode === 'count' && stats) {
      return {
        text: capSearch(`${body}\n\n${stats.matches} matches in ${stats.files} files`),
      };
    }
    return {text: capSearch(body)};
  },
};
