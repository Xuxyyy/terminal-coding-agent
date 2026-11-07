import {z} from 'zod';
import type {Tool} from './registry.js';
import {accessSchema, executable} from '../sandbox/policy.js';
import {runCommand, type SandboxResult} from '../sandbox/run.js';
import type {SandboxMode} from '../sandbox/mode.js';

const TIMEOUT_MS = 120_000;
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 20_000;

export const BASH_EXECUTION_GUIDANCE =
  'Commands use an allowlisted environment with the existing HOME and persistent workspace temporary files. Shell exports do not persist. ' +
  'Shell results include the exit status and captured output, which may be truncated. ACC stops managed commands that exceed 32 MiB of output. ' +
  `The default foreground timeout is ${TIMEOUT_MS / 1000} seconds. ` +
  'When Sandbox is On, network is off by default. Request extra paths or network with access. ' +
  'Do not blindly retry blocked commands. Earlier parts may have run, so inspect their effects before retrying.';

const schema = z.object({
  command: z.string().describe('Shell command to run in the workspace root.'),
  description: z
    .string()
    .optional()
    .describe('Short sentence saying what this command is for, shown to the user.'),
  access: accessSchema.optional().describe('Extra access when Sandbox is On; ignored when Off. Requires approval for this call.'),
});

export function capOutput(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  const cut = text.length - HEAD_CHARS - TAIL_CHARS;
  return (
    text.slice(0, HEAD_CHARS) +
    `\n... [truncated ${cut} chars]\n` +
    text.slice(text.length - TAIL_CHARS)
  );
}

function formatResult(result: SandboxResult, sandbox: SandboxMode | undefined, timeout: number, capped = false): string {
  const capture = result.outputIncomplete ? '\n[shell exited; output capture is incomplete and descendant cleanup is uncertain]' : '';
  const note = result.interrupted ? '\nstopped by the user' : result.timedOut ? `\ncommand timed out after ${timeout / 1000}s` : '';
  const output = result.stdout + result.stderr;
  const blocked = sandbox === 'on' && /Operation not permitted|Permission denied/.test(output)
    ? '\n[sandbox blocked access; request a specific path or network grant if needed. Earlier parts of the command may already have run.]'
    : '';
  return `[exit ${result.code}]\n${capped ? output : capOutput(output)}${note}${capture}${blocked}`;
}

export const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root. Use it to run tests, use git, and delete files. ' +
    'Use glob to find files and grep to search contents. Use shell searches for pipelines, ' +
    "git history, or another command's output. " +
    BASH_EXECUTION_GUIDANCE,
  schema,
  request(args) {
    const parsed = schema.parse(args);
    return {kind: 'command', command: parsed.command, reason: parsed.description};
  },
  access(args) {
    return schema.parse(args).access ?? {};
  },
  async run(args, ctx) {
    const parsed = schema.parse(args);
    const program = executable('bash');
    if (!program) throw new Error('bash is not on PATH');
    const result = await runCommand({
      root: ctx.root,
      sandbox: ctx.sandbox,
      program,
      args: ['--noprofile', '--norc', '-c', parsed.command],
      signal: ctx.host.signal,
      timeoutMs: TIMEOUT_MS,
      access: ctx.sandboxAccess,
    });
    return {text: formatResult(result, ctx.sandbox, TIMEOUT_MS), failure: result.code !== 0 || result.timedOut || result.interrupted, execution: result.timedOut || result.interrupted || result.outputIncomplete ? 'uncertain' : 'known_result'};
  },
};

const backgroundSchema = schema.extend({
  lifetime: z.enum(['finite', 'temporary_service', 'retained_service']).optional()
    .describe(
      'Choose lifetime separately from scheduling. The default, finite, is for work that must finish. Wait for required results before dependent work. ' +
      'Check completed task output and exit status and handle failures before reporting completion. ' +
      'Use temporary_service for a service needed only during the run. ACC cleans it up on exit. ' +
      'Only the main agent may start a retained_service, and only when the user task explicitly requires it to stay available after ACC exits. ' +
      'Set required_by_task and call task_handoff when the retained service is ready. Run it in the foreground of its managed shell, preferably with exec. ' +
      'Keep it attached to that shell and leave daemonization and shell & out of the command. Its output goes directly to private log files. ' +
      'Both service lifetimes require run_in_background. Subagent commands stop when their owning subagent finishes.',
    ),
  required_by_task: z.string().trim().min(1).optional().describe('For retained_service, explain the explicit user requirement to keep it available after ACC exits.'),
  run_in_background: z.boolean().optional().describe(
    'Set true to get a task ID while the command runs and continue using other tools. Omit shell &. ' +
    'Use task_output for status and paged output and task_stop to stop an owned command. ' +
    'Completion sends a runtime notice to the owning agent, including subagents, and can resume the owner after a reply. ' +
    'Runtime notices come from ACC and carry no human approval. Avoid repeated status-only polling and use diagnostics when progress is uncertain.',
  ),
  timeout: z.number().int().min(1).max(7_200_000).optional()
    .describe(
      'Time in milliseconds. Foreground wait defaults to 120000, with a maximum of 600000. A command that exceeds its foreground wait ' +
      'moves to the background without restarting and gets 1800000 ms of background runtime. ' +
      'Explicit background runtime defaults to 1800000, with a maximum of 7200000. The run’s deadline and step budget still apply.',
    ),
}).superRefine((args, ctx) => {
  if (args.lifetime && args.lifetime !== 'finite' && !args.run_in_background) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['run_in_background'], message: 'services require run_in_background true'});
  }
  if (args.lifetime === 'retained_service' && !args.required_by_task) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['required_by_task'], message: 'explain the explicit user requirement for retention'});
  }
  if (!args.run_in_background && args.timeout !== undefined && args.timeout > 600_000) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['timeout'], message: 'foreground timeout must not exceed 600000 ms'});
  }
});

export const BACKGROUND_INSTRUCTIONS =
  ' See run_in_background and timeout for scheduling, and lifetime and task_handoff for service ownership and handoff.';

export const backgroundBash: Tool = {
  ...bash,
  schema: backgroundSchema,
  description: bash.description + BACKGROUND_INSTRUCTIONS,
  async run(args, ctx) {
    const parsed = backgroundSchema.parse(args);
    if (!ctx.backgroundTasks) throw new Error('background Bash is unavailable in this run');
    const program = executable('bash');
    if (!program) throw new Error('bash is not on PATH');
    const result = await ctx.backgroundTasks.run({
      root: ctx.root, sandbox: ctx.sandbox, program,
      args: ['--noprofile', '--norc', '-c', parsed.command],
      command: parsed.command, description: parsed.description,
      signal: ctx.host.signal, access: ctx.sandboxAccess,
      lifetime: parsed.lifetime, requiredByTask: parsed.required_by_task,
      background: parsed.run_in_background === true, timeout: parsed.timeout,
    });
    if ('result' in result) {
      return {text: formatResult(result.result, ctx.sandbox, parsed.timeout ?? TIMEOUT_MS, true), failure: result.result.code !== 0 || result.result.timedOut || result.result.interrupted, execution: result.result.timedOut || result.result.interrupted || result.result.outputIncomplete ? 'uncertain' : 'known_result'};
    }
    const notice = result.moved
      ? `Command did not complete within its ${(parsed.timeout ?? TIMEOUT_MS) / 1000}s foreground wait and was moved to the background.`
      : 'Command started in the background.';
    return {failure: false, text: `${notice}\n${JSON.stringify(result.task)}\nUse task_output for output. Completion will notify you automatically.`};
  },
};
