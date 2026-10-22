import {z} from 'zod';
import {runCommand} from '../sandbox/run.js';
import {accessSchema, executable} from '../sandbox/policy.js';
import type {Tool} from './registry.js';

const taskId = z.string().min(1).describe('Task ID returned by Bash in this agent’s run.');
const outputSchema = z.object({
  task_id: taskId,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('Character offset, default 0.'),
  limit: z.number().int().min(1).max(30_000).optional().describe('Maximum output characters, default 30000.'),
});

export const taskOutput: Tool = {
  name: 'task_output',
  description: 'Read a managed command’s status, exit reason, and saved output without waiting. ' +
    'Use next_offset to read another page. Access is limited to your own tasks. ' +
    'Completion notices arrive automatically; do not repeatedly poll running tasks.',
  schema: outputSchema,
  async run(args, ctx) {
    const parsed = outputSchema.parse(args);
    if (!ctx.backgroundTasks) throw new Error('background tasks are unavailable in this run');
    return {text: JSON.stringify(await ctx.backgroundTasks.output(parsed.task_id, parsed.offset, parsed.limit))};
  },
};

const stopSchema = z.object({task_id: taskId});

export const taskStop: Tool = {
  name: 'task_stop',
  description: 'Stop a managed command and its process group by task ID. Access is limited to your own tasks. ' +
    'Also stops retained services before normal completion; handed-off services have a recorded external stop command.',
  schema: stopSchema,
  async run(args, ctx) {
    const parsed = stopSchema.parse(args);
    if (!ctx.backgroundTasks) throw new Error('background tasks are unavailable in this run');
    const task = await ctx.backgroundTasks.stop(parsed.task_id);
    return {text: JSON.stringify(task), failure: task.status === 'failed' || task.status === 'output_limit',
      execution: task.status === 'failed' || task.status === 'output_limit' || task.outputIncomplete || task.cleanupUncertain ? 'uncertain' : 'known_result'};
  },
};

const handoffSchema = z.object({
  task_id: taskId,
  command: z.string().min(1).describe('Readiness check for the user-requested behavior. Must exit zero only when usable. Checking a PID alone is insufficient.'),
  description: z.string().min(1).describe('What requested behavior this readiness check verifies.'),
  access: accessSchema.optional(),
});

export const taskHandoff: Tool = {
  name: 'task_handoff',
  description: 'Verify a retained_service is ready for handoff using a shell check (10 second limit). ' +
    'A successful check makes it eligible to survive successful normal ACC completion. Until then cancellation and task_stop still stop it. ' +
    'Use a check of the requested behavior, not just process existence. Logs and a stop command are saved in the service record.',
  schema: handoffSchema,
  request(args) {
    const parsed = handoffSchema.parse(args);
    return {kind: 'command', command: parsed.command, reason: parsed.description};
  },
  access(args) { return handoffSchema.parse(args).access ?? {}; },
  async run(args, ctx) {
    const parsed = handoffSchema.parse(args);
    if (!ctx.backgroundTasks) throw new Error('background tasks are unavailable in this run');
    ctx.backgroundTasks.beginReadiness(parsed.task_id);
    const program = executable('bash');
    if (!program) throw new Error('bash is not on PATH');
    const result = await runCommand({root: ctx.root, sandbox: ctx.sandbox, program,
      args: ['--noprofile', '--norc', '-c', parsed.command], signal: ctx.host.signal,
      access: ctx.sandboxAccess, timeoutMs: 10_000});
    const output = (result.stdout + result.stderr).slice(-30_000);
    if (result.code !== 0 || result.interrupted || result.timedOut || result.outputIncomplete) {
      return {text: `Readiness check failed; service remains owned and is not eligible for handoff. [exit ${result.code}]\n${output}`,
        failure: true, execution: result.interrupted || result.timedOut || result.outputIncomplete ? 'uncertain' : 'known_result'};
    }
    const task = ctx.backgroundTasks.verify(parsed.task_id, {command: parsed.command, verifiedAt: new Date().toISOString(), output});
    return {text: `Readiness verified. Service will be handed off only on successful normal completion.\n${JSON.stringify(task)}`};
  },
};
