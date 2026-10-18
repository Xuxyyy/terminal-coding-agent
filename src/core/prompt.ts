import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {DEFAULT_SANDBOX, type SandboxMode} from './sandbox/mode.js';
import {DEFAULT_MODE, type Mode} from './permission/mode.js';
import INSTRUCTIONS from './system-prompt.js';

export function environmentBlock(root: string): string {
  const isRepo = fs.existsSync(path.join(root, '.git'));
  return [
    '<environment>',
    `working directory: ${root}`,
    `platform: ${os.platform()} ${os.release()}`,
    `git repository: ${isRepo ? 'yes' : 'no'}`,
    '</environment>',
  ].join('\n');
}

export function sandboxInstructions(sandbox: SandboxMode): string {
  const shared = 'Shell and file workers use a clean environment and private HOME and temporary files. Permission checks remain active.';
  return sandbox === 'on'
    ? `Sandbox: On. File and shell tools use OS isolation. Known credential storage is hidden and network is off by default.
Request extra paths or network with bash's access argument. Extra access requires approval for each call.
A failed sandbox backend never falls back to Off. A blocked command may already have changed files; inspect its effects before retrying.
${shared}`
    : `Sandbox: Off. There is no ACC OS isolation for file or network access. Bash's access argument is ignored.
Environment cleanup reduces inherited secrets but does not stop commands from reading credential files. Do not treat it as complete credential protection.
${shared}`;
}

export function systemPrompt(root: string, _mode: Mode = DEFAULT_MODE, sandbox: SandboxMode = DEFAULT_SANDBOX): string {
  return `${INSTRUCTIONS}\n\n${sandboxInstructions(sandbox)}\n\n${environmentBlock(root)}`;
}

const SUBAGENT = `You are a sub-agent. Another agent handed you one self-contained job and is blocked until you answer.

You cannot ask the user anything — there is nobody there to answer. Decide with what you can find, and say in your report what you were unsure about.

Your final message is the whole report. Nothing else you do reaches the caller: not the files you read, not the commands you ran, not a single tool result. Put every fact the caller needs into that last message, with the paths and line numbers you found.`;

export function subagentPrompt(
  root: string,
  mode: Mode = DEFAULT_MODE,
  role?: string,
  sandbox: SandboxMode = DEFAULT_SANDBOX,
): string {
  const base = `${systemPrompt(root, mode, sandbox)}\n\n${SUBAGENT}`;
  return role ? `${base}\n\n${role}` : base;
}
