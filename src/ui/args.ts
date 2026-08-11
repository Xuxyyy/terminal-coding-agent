import * as fs from 'node:fs';
import * as path from 'node:path';

export type CliOptions = {
  workspaceRoot: string;
};

export function parseArgs(args: string[]): CliOptions {
  let workspace: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--workspace') {
      const value = args[index + 1];
      if (!value) throw new Error('missing value for --workspace');
      workspace = value;
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!workspace) throw new Error('missing required --workspace argument');
  const workspaceRoot = path.resolve(workspace);
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`workspace does not exist: ${workspaceRoot}`);
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspaceRoot}`);
  }

  return {workspaceRoot};
}
