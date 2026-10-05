import {z} from 'zod';
import type {Tool} from './registry.js';
import {accessSchema, executable} from '../sandbox/policy.js';
import {runCommand} from '../sandbox/run.js';

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

export const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root. Use it to run tests, use git, and delete files. ' +
    'To search file contents use the grep tool instead; reach for a shell search only to build a pipeline, ' +
    "to search git history, or to search another command's output. " +
    'Clean environment and private HOME/temp files. ' +
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
    const note = result.interrupted ? '\nstopped by the user' : result.timedOut ? `\ncommand timed out after ${TIMEOUT_MS / 1000}s` : '';
    const output = result.stdout + result.stderr;
    const blocked = ctx.sandbox === 'on' && /Operation not permitted|Permission denied/.test(output)
      ? '\n[sandbox blocked access; request a specific path or network grant if needed. Earlier parts of the command may already have run.]'
      : '';
    return {text: `[exit ${result.code}]\n${capOutput(output)}${note}${blocked}`};
  },
};
