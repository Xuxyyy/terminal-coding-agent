import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CliOptions = {
  workspaceRoot: string;
  print: string | null;
  json: boolean;
  yes: boolean;
  maxSeconds: number;
};

const DEFAULT_MAX_SECONDS = 300;

function refuse(root: string): void {
  const hint = 'cd into a project folder first';
  if (root === path.resolve(os.homedir())) {
    throw new Error(`refusing to run in your home directory; ${hint}`);
  }
  if (path.parse(root).root === root) {
    throw new Error(`refusing to run in the filesystem root; ${hint}`);
  }
}

function valueFor(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

export function parseArgs(
  args: string[],
  cwd: string = process.cwd(),
): CliOptions {
  let print: string | null = null;
  let json = false;
  let yes = false;
  let maxSeconds = DEFAULT_MAX_SECONDS;
  let maxSecondsGiven = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--workspace') {
      throw new Error(
        '--workspace was removed; cd into the folder you want to work on',
      );
    }
    if (arg === '-p' || arg === '--print') {
      i += 1;
      print = valueFor(args, i, arg);
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--max-seconds') {
      i += 1;
      const raw = valueFor(args, i, arg);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--max-seconds needs a positive number, got: ${raw}`);
      }
      maxSeconds = parsed;
      maxSecondsGiven = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  if (print === null) {
    const stray = [
      json ? '--json' : null,
      yes ? '--yes' : null,
      maxSecondsGiven ? '--max-seconds' : null,
    ].filter((flag): flag is string => flag !== null);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(' and ')} only applies to print mode; add -p "your task"`,
      );
    }
  }

  const workspaceRoot = path.resolve(cwd);
  refuse(workspaceRoot);
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`folder does not exist: ${workspaceRoot}`);
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`not a folder: ${workspaceRoot}`);
  }

  return {workspaceRoot, print, json, yes, maxSeconds};
}
