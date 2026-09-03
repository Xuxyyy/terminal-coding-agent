import {z} from 'zod';
import {INTERRUPTED, type AgentEvent, type Host, type Usage} from '../host.js';
import {runAgent} from '../loop.js';
import type {Mode} from '../permission/mode.js';
import {subagentPrompt} from '../prompt.js';
import {addTask, createSession} from '../session.js';
import {toolsFor} from './index.js';
import type {Tool, ToolOutput} from './registry.js';

const NAME = 'agent';

const NO_CHOICE =
  'the sub-agent could not start: this run has no model to give it. ' +
  'Do the job yourself with the other tools.';

const NOTHING = 'the sub-agent returned nothing';

const schema = z.object({
  description: z
    .string()
    .describe('Three to five words naming the job, shown to the user while the sub-agent works.'),
  prompt: z
    .string()
    .describe(
      'The whole job. The sub-agent starts with no memory of this conversation and cannot ask ' +
        'a question, so include every fact it needs and say exactly what to report back.',
    ),
});

export function childTools(mode: Mode, allow?: string[]): Tool[] {
  const offered = toolsFor(mode).filter((tool) => tool.name !== NAME);
  if (!allow) return offered;
  return offered.filter((tool) => allow.includes(tool.name));
}

export function childHost(host: Host): {host: Host; events: AgentEvent[]} {
  const events: AgentEvent[] = [];
  return {
    host: {
      signal: host.signal,
      onEvent(event) {
        events.push(event);
      },
      confirm(request) {
        return host.confirm({...request, reason: `sub-agent: ${request.reason}`});
      },
    },
    events,
  };
}

export function report(events: AgentEvent[]): ToolOutput {
  let said = '';
  let usage: Usage | undefined;
  const errors: string[] = [];
  for (const event of events) {
    if (event.type === 'text_delta') said += event.text;
    if (event.type === 'turn_end') usage = event.usage;
    if (event.type === 'error') errors.push(event.message);
  }
  const text = [said.trim(), ...errors].filter(Boolean).join('\n');
  return {text: text || NOTHING, usage};
}

export const subagent: Tool = {
  name: NAME,
  description:
    'Hand one self-contained job to a sub-agent that works on its own and reports back a single message. ' +
    'Use it when the answer matters but the search does not — finding where something lives across many ' +
    'files, or a question that would cost you a dozen reads. The sub-agent shares your workspace and your ' +
    'tools, but starts with no memory of this conversation and cannot ask anyone a question, so put ' +
    'everything it needs in the prompt. It runs to completion before you continue, and you see only its ' +
    'final message — never the tools it called.',
  schema,
  async run(rawArguments, ctx) {
    const args = schema.parse(rawArguments);
    if (!ctx.choice) return {text: NO_CHOICE};
    const session = createSession(
      ctx.root,
      subagentPrompt(ctx.root, ctx.mode),
      ctx.choice.contextWindow,
    );
    session.mode = ctx.mode;
    session.allowed = ctx.allowed;
    addTask(session, args.prompt);
    const child = childHost(ctx.host);
    await runAgent(session, ctx.choice, child.host, childTools(ctx.mode));
    if (ctx.host.signal.aborted) return {text: INTERRUPTED};
    return report(child.events);
  },
};
