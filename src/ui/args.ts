import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CliOptions = {
  workspaceRoot: string;
};

function refuse(root: string): void {
  const hint = 'cd into a project folder first';
  if (root === path.resolve(os.homedir())) {
    throw new Error(`refusing to run in your home directory; ${hint}`);
  }
  if (path.parse(root).root === root) {
    throw new Error(`refusing to run in the filesystem root; ${hint}`);
  }
}

export function parseArgs(
  args: string[],
  cwd: string = process.cwd(),
): CliOptions {
  for (const arg of args) {
    if (arg === '--workspace') {
      throw new Error(
        '--workspace was removed; cd into the folder you want to work on',
      );
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  const workspaceRoot = path.resolve(cwd);
  refuse(workspaceRoot);
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`folder does not exist: ${workspaceRoot}`);
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`not a folder: ${workspaceRoot}`);
  }

  return {workspaceRoot};
}
