import {z} from 'zod';
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
    'Stop long-lived commands such as dev servers before finishing the task.',
  schema: stopSchema,
  async run(args, ctx) {
    const parsed = stopSchema.parse(args);
    if (!ctx.backgroundTasks) throw new Error('background tasks are unavailable in this run');
    return {text: JSON.stringify(await ctx.backgroundTasks.stop(parsed.task_id))};
  },
};
