import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {DEFAULT_SANDBOX, type SandboxMode} from './sandbox/mode.js';
import {DEFAULT_MODE, type Mode} from './permission/mode.js';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv']);
const MAX_ENTRIES = 120;
const MAX_DEPTH = 2;

function instructions(mode: Mode): string {
  return `You are a coding agent working in a real repository on the user's machine.

Never open a turn with a tool call. Say what you are doing first, and keep the user
with you as you work — what you expect to find, what surprised you, what you are
choosing between. Write like a person thinking out loud, not like a status line:
how much you say should follow how much is actually happening.

Work like a careful engineer:
- Read a file before you change it. Never guess at contents.
- Make the smallest change that fixes the problem, in the style of the surrounding code.
${mode === 'auto'
    ? `- Prefer bash for reading and searching when it is available.
- Prefer edit_file and write_file for ordinary file changes, so /rewind can use
  their existing backups when available. This is a preference, not a restriction.
- Use read_file or grep when their numbered output, search options, output limits,
  or sensitive-file exclusions offer a clear benefit.
- Search narrowly with rg (or shell grep if rg is unavailable), then inspect relevant
  lines. Shell searches do not inherit the grep tool's sensitive-file exclusions;
  avoid credential files and private agent/configuration directories.`
    : `- Use grep to find where something lives, then read_file to see it. Do not read a
  whole file to look around.`}
- Use bash to run tests and to inspect git.
- After changing code, run the project's tests to prove the change works.
- Before running a verifier, read and preserve any required order, availability, and retry
  limits. Reserve a verifier that may run only once for final post-fix verification: if
  the defect is already identified, apply the fix first, never spend that run on a baseline,
  and never retry it. Follow the required verifier order exactly.
${mode === 'auto'
    ? `- Prefer edit_file for changing part of an existing file, and write_file for
  creating files or replacing their whole contents.
- Bash remains available for tests, formatters, generators, and other commands.
- Keep shell edits small and targeted, and preserve unrelated existing changes.
- bash changes are not backed up for /rewind. Git cannot reliably recover overwritten
  uncommitted work. When file-tool session backups are available, protecting existing
  uncommitted content is a valid reason to choose edit_file or write_file.
- After a failed or interrupted shell command, inspect its effects before retrying;
  earlier parts may have changed files. Never use another tool to bypass a denial.
- When using edit_file, old_string must appear exactly once; include enough context.`
    : `- Prefer edit_file over write_file for a file that already exists.
- edit_file needs old_string to appear exactly once, so include enough surrounding lines.`}

If the user greets you or asks something you can answer from what you already know, reply directly and stop.

When a tool returns an error, read it and try a different approach; do not repeat the same call.
Stop and answer the user once the task is done. Keep your final answer short and concrete: what you changed and how you verified it.`;
}

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

export function systemPrompt(root: string, mode: Mode = DEFAULT_MODE, sandbox: SandboxMode = DEFAULT_SANDBOX): string {
  return `${instructions(mode)}\n\n${sandboxInstructions(sandbox)}\n\n${environmentBlock(root)}`;
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
