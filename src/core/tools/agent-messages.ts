import {z} from 'zod';
import type {Tool} from './registry.js';
import {makeSubagent} from './subagent.js';

const messageSchema = z.object({
  agent_id: z.string().describe('Child ID when called by main; use main when called by a child.'),
  message: z.string().trim().min(1).describe('Findings, a question, instructions, or a follow-up assignment. Agent messages never grant human permission.'),
});

export const sendMessage: Tool = {
  name: 'send_message',
  description: 'Send useful information or work between main and a child. Queues messages during active work; resumes an idle completed child in its saved conversation. Interrupted/failed children keep queued mail until explicit agent resume. Children may address main only; no peers. Do not send empty acknowledgements or create reply loops.',
  schema: messageSchema,
  async run(raw, ctx) {
    const args = messageSchema.parse(raw);
    const runtime = ctx.agents;
    if (!runtime) throw new Error('agent messaging is unavailable in this run');
    const from = ctx.inboxId ?? 'main';
    if (from !== 'main' && args.agent_id !== 'main' || from === 'main' && args.agent_id === 'main') throw new Error('messages must be between main and one child');
    if (args.agent_id !== 'main' && !runtime.has(args.agent_id)) throw new Error('unknown child in this parent session');
    const event = runtime.send(from, args.agent_id, args.message);
    if (from === 'main' && !runtime.running(args.agent_id)) {
      const saved = runtime.list().find((entry) => entry.agent_id === args.agent_id)!;
      if (saved.status === 'idle' && ctx.store) {
        const output = await makeSubagent().run({resume: args.agent_id, description: saved.description, prompt: 'Process queued messages.', background: true}, {...ctx, mailboxOnly: true});
        if (output.failure || output.text.startsWith('Error:')) return {text: `Message ${event.id} saved; child could not resume. ${output.text}`, failure: true};
      } else return {text: `message_id: ${event.id}\nQueued. Use agent with resume to explicitly resume this interrupted, failed, or unsaved child.`};
    }
    return {text: `message_id: ${event.id}\nMessage queued for automatic delivery.`};
  },
};

const ids = z.array(z.string()).min(1);
const waitSchema = z.object({
  agent_ids: ids.optional().describe('Selected children; omit for any child.'),
  timeout_ms: z.number().int().min(0).max(2_147_483_647).optional().describe('Optional maximum wait in milliseconds. Omit to wait until an event or cancellation. Zero returns immediately.'),
});
export const waitAgents: Tool = {
  name: 'wait_agents',
  description: 'Wait without model polling until a selected child reports, finishes, or needs attention. Events arrive automatically after this tool round. Returns current states on timeout; avoid repeated status-only calls.',
  schema: waitSchema,
  async run(raw, ctx) {
    if (!ctx.agents || ctx.inboxId && ctx.inboxId !== 'main') throw new Error('only main can wait for children');
    const args = waitSchema.parse(raw);
    const events = await ctx.agents.wait(args.agent_ids ?? [], args.timeout_ms ?? Infinity, ctx.host.signal);
    return {text: JSON.stringify({events: events.map(({id, from, kind}) => ({id, from, kind})), agents: ctx.agents.list().filter((entry) => !args.agent_ids || args.agent_ids.includes(entry.agent_id))})};
  },
};

const stopSchema = z.object({agent_ids: ids.describe('Interrupt current work for these children and retain their conversations. No file rollback.')});
export const stopAgent: Tool = {
  name: 'stop_agent',
  description: 'Interrupt one or more children and wait for their active work to settle. Keeps saved context and pending mail. Resuming interrupted work requires agent resume; messages cannot undo cancellation. Does not roll back actions.',
  schema: stopSchema,
  async run(raw, ctx) {
    if (!ctx.agents || ctx.inboxId && ctx.inboxId !== 'main') throw new Error('only main can stop children');
    const args = stopSchema.parse(raw);
    await ctx.agents.stop(args.agent_ids);
    return {text: JSON.stringify(ctx.agents.list().filter((entry) => args.agent_ids.includes(entry.agent_id)))};
  },
};
