import {z} from 'zod';
import type {Tool} from './registry.js';
import {accessSchema, executable} from '../sandbox/policy.js';
import {runCommand, type SandboxResult} from '../sandbox/run.js';
import type {SandboxMode} from '../sandbox/mode.js';

const TIMEOUT_MS = 120_000;
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 20_000;

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
    'Find files with glob; search contents with grep. Use shell searches for pipelines, ' +
    "git history, or another command's output. " +
    'Clean environment; existing HOME and persistent workspace temp files. Exports do not persist. ' +
    'When Sandbox is On, network is off; request extra paths or network with access. Do not blindly retry blocked commands: earlier parts may have run.',
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
    .describe('Independent of scheduling: finite work must finish and be checked; temporary_service is cleaned up; retained_service must survive successful completion because the user task requires it.'),
  required_by_task: z.string().trim().min(1).optional().describe('For retained_service, explain the explicit user requirement to keep it available after ACC exits.'),
  run_in_background: z.boolean().optional().describe('Return a task ID while this command continues running. No shell & is needed.'),
  timeout: z.number().int().min(1).max(7_200_000).optional()
    .describe('Milliseconds: foreground wait defaults to 120000, max 600000; explicit background runtime defaults to 1800000, max 7200000.'),
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
  ' Background commands keep running while you use other tools. Set run_in_background to true to start one. ' +
  'A foreground command that exceeds its timeout moves to the background without restarting; its background runtime defaults to 30 minutes. ' +
  'Completion automatically sends a runtime notice; the main agent resumes even after a reply. Avoid repeated status-only polling; use diagnostic checks when progress is uncertain. ' +
  'Use task_output to read status and paged output, and task_stop to stop a command. ' +
  'Wait for required results before dependent work and verify exit status before claiming success. ' +
  'Use lifetime finite (default) for work whose result must be checked. Use temporary_service for servers needed only during the run; they are cleaned up on exit. ' +
  'Only the main agent may start retained_service, and only when required by the user task: set required_by_task explicitly. ' +
  'Run retained services in the foreground of their managed shell (prefer exec); do not daemonize or use shell &. Their output goes directly to private log files. ' +
  'Call task_handoff with a readiness command that checks the requested behavior, such as an actual endpoint response; process existence alone is insufficient. ' +
  'Only a successful readiness check makes retention eligible. Handoff occurs on successful normal completion, lets ACC exit, and records identity, logs, and a stop command. ' +
  'Cancellation, deadlines, errors, step limits, and explicit task_stop still stop owned services, including those ready for handoff. ' +
  'Readiness checks use their own approved sandbox access. After handoff the environment owns the service and its log growth; include the service record in your final reply. ' +
  'The overall deadline and step budget still apply. Commands stop after 32 MiB of output. ' +
  'Subagent commands stop when their owning subagent finishes.';

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
    return {text: `${notice}\n${JSON.stringify(result.task)}\nUse task_output for output. Completion will notify you automatically.`};
  },
};
