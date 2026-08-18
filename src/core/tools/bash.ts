import {spawn} from 'node:child_process';
import {z} from 'zod';
import type {Tool} from './registry.js';

const TIMEOUT_MS = 120_000;
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 20_000;

const schema = z.object({
  command: z.string().describe('Shell command to run in the workspace root.'),
  description: z
    .string()
    .optional()
    .describe('Short sentence saying what this command is for, shown to the user.'),
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
    "to search git history, or to search another command's output.",
  schema,
  request(args) {
    const parsed = schema.parse(args);
    return {kind: 'command', command: parsed.command, reason: parsed.description};
  },
  run(args, ctx) {
    const parsed = schema.parse(args);
    return new Promise((resolve) => {
      const child = spawn('bash', ['-lc', parsed.command], {
        cwd: ctx.root,
        signal: ctx.host.signal,
        timeout: TIMEOUT_MS,
      });
      let output = '';
      const collect = (chunk: Buffer) => {
        output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.name === 'AbortError') {
          resolve({text: '[exit 130]\nstopped by the user'});
          return;
        }
        resolve({text: `[exit 1]\n${error.message}`});
      });
      child.on('close', (code, signal) => {
        const status = code === null ? 124 : code;
        const note =
          signal === 'SIGTERM' && code === null
            ? `\ncommand timed out after ${TIMEOUT_MS / 1000}s`
            : '';
        resolve({text: `[exit ${status}]\n${capOutput(output)}${note}`});
      });
    });
  },
};
