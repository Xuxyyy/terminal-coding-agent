import {z} from 'zod';
import {agentsOf, type AgentDefinition} from '../agents.js';
import {createClient, type ModelChoice} from '../client.js';
import {INTERRUPTED, type AgentEvent, type Host, type Usage} from '../host.js';
import {runAgent} from '../loop.js';
import {stricterMode, type Mode} from '../permission/mode.js';
import {subagentPrompt} from '../prompt.js';
import {addTask, createSession} from '../session.js';
import {toolsFor} from './index.js';
import type {Tool, ToolOutput} from './registry.js';

const NAME = 'agent';

const NO_CHOICE =
  'the sub-agent could not start: this run has no model to give it. ' +
  'Do the job yourself with the other tools.';

const NOTHING = 'the sub-agent returned nothing';

const DESCRIPTION =
  'Three to five words naming the job, shown to the user while the sub-agent works.';
const PROMPT =
  'The whole job. The sub-agent starts with no memory of this conversation and cannot ask ' +
  'a question, so include every fact it needs and say exactly what to report back.';

const schema = z.object({
  description: z
    .string()
    .describe(DESCRIPTION),
  prompt: z.string().describe(PROMPT),
});

const BASE_DESCRIPTION =
  'Hand one self-contained job to a sub-agent that works on its own and reports back a single message. ' +
  'Use it when the answer matters but the search does not — finding where something lives across many ' +
  'files, or a question that would cost you a dozen reads. The sub-agent shares your workspace and your ' +
  'tools, but starts with no memory of this conversation and cannot ask anyone a question, so put ' +
  'everything it needs in the prompt. It runs to completion before you continue, and you see only its ' +
  'final message — never the tools it called.';

type ClientFactory = (modelId?: string) => ModelChoice;

export function childTools(mode: Mode, allow?: string[]): Tool[] {
  const offered = toolsFor(mode).filter((tool) => tool.name !== NAME);
  if (!allow) return offered;
  return allow
    .map((name) => offered.find((tool) => tool.name === name))
    .filter((tool): tool is Tool => tool !== undefined);
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
  const turns: string[] = [''];
  let usage: Usage | undefined;
  const errors: string[] = [];
  for (const event of events) {
    if (event.type === 'text_delta') turns[turns.length - 1] += event.text;
    if (event.type === 'tool_start') turns.push('');
    if (event.type === 'turn_end') usage = event.usage;
    if (event.type === 'error') errors.push(event.message);
  }
  const spoken = turns.map((turn) => turn.trim()).filter(Boolean);
  const said = spoken[spoken.length - 1] ?? '';
  const text = [said, ...errors].filter(Boolean).join('\n');
  return {text: text || NOTHING, usage};
}

export function makeSubagent(
  definitions: AgentDefinition[] = agentsOf(),
  clientFactory: ClientFactory = createClient,
): Tool {
  const sorted = [...definitions].sort((a, b) => a.name.localeCompare(b.name));
  const namedSchema = schema.extend({agent: z.string().optional()});
  const selectedSchema = sorted.length === 0 ? schema : namedSchema;
  const parameters =
    sorted.length === 0
      ? undefined
      : {
          type: 'object',
          properties: {
            description: {type: 'string', description: DESCRIPTION},
            prompt: {type: 'string', description: PROMPT},
            agent: {
              type: 'string',
              enum: sorted.map((definition) => definition.name),
              description: 'The named global agent type to use for this job.',
            },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        };
  const routing = sorted
    .map((definition) => `${definition.name}: ${definition.description}`)
    .join('\n');

  return {
    name: NAME,
    description: routing ? `${BASE_DESCRIPTION}\n\n${routing}` : BASE_DESCRIPTION,
    schema: selectedSchema,
    ...(parameters ? {parameters} : {}),
    async run(rawArguments, ctx) {
      const args = selectedSchema.parse(rawArguments) as {
        description: string;
        prompt: string;
        agent?: string;
      };
      const definition = args.agent
        ? sorted.find((candidate) => candidate.name === args.agent)
        : undefined;
      if (args.agent && !definition) {
        return {
          text:
            `Error: unknown agent type '${args.agent}'. ` +
            `Choose one of: ${sorted.map((candidate) => candidate.name).join(', ')}.`,
        };
      }
      if (!ctx.choice && !definition?.model) return {text: NO_CHOICE};

      let choice = ctx.choice;
      if (definition?.model) {
        try {
          choice = clientFactory(definition.model);
        } catch (error) {
          return {
            text: `Error: agent '${definition.name}' could not start: ${(error as Error).message}`,
          };
        }
      }
      if (!choice) return {text: NO_CHOICE};

      const mode = definition?.permissionMode
        ? stricterMode(ctx.mode, definition.permissionMode)
        : ctx.mode;
      const available = childTools(mode);
      if (definition?.tools) {
        const availableNames = new Set(available.map((tool) => tool.name));
        const missing = definition.tools.filter((name) => !availableNames.has(name));
        if (missing.length > 0) {
          return {
            text:
              `Error: agent '${definition.name}' cannot start because these tools are unavailable: ` +
              missing.join(', '),
          };
        }
      }
      const tools = definition?.tools
        ? definition.tools
            .map((name) => available.find((tool) => tool.name === name))
            .filter((tool): tool is Tool => tool !== undefined)
        : available;

      const session = createSession(
        ctx.root,
        subagentPrompt(ctx.root, mode, definition?.prompt),
        choice.contextWindow,
      );
      session.mode = mode;
      session.allowed = ctx.allowed;
      addTask(session, args.prompt);
      const child = childHost(ctx.host);
      await runAgent(session, choice, child.host, tools);
      if (ctx.host.signal.aborted) return {text: INTERRUPTED};
      return report(child.events);
    },
  };
}

export const subagent: Tool = makeSubagent([]);
