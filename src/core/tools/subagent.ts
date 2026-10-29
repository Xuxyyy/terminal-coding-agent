import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ReasoningEffort} from '../models.js';
import {agentsOf, type AgentDefinition} from '../agents.js';
import {createClient, modelSettings, type ModelChoice} from '../client.js';
import {INTERRUPTED, type AgentEvent, type BackgroundTaskInfo, type Host, type Usage} from '../host.js';
import {runAgent} from '../loop.js';
import {stricterMode, type Mode} from '../permission/mode.js';
import {subagentPrompt} from '../prompt.js';
import {addTask, createSession, restoreMessages, setMeasured} from '../session.js';
import {DEFAULT_SANDBOX} from '../sandbox/mode.js';
import {listSubagents, loadSubagent, openSubagent, startSubagent} from '../subagent-store.js';
import type {Rules} from '../settings.js';
import {recoverToolResults} from '../records.js';
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
  'The assignment or follow-up. New agents start without the parent conversation. Resumed agents keep ' +
  'their own earlier context. Include needed facts and say exactly what to report back.';

const BACKGROUND = 'Run concurrently and return agent_id immediately (default true). Set false to wait for the final report.';

const schema = z.object({
  action: z.enum(['run', 'list']).optional().describe('Run an assignment (default), or list saved children of this parent session.'),
  description: z.string().optional().describe(DESCRIPTION),
  prompt: z.string().optional().describe(PROMPT),
  background: z.boolean().optional().describe(BACKGROUND),
  resume: z.string().optional().describe('The saved agent_id to resume with a follow-up assignment. Omit to create a new child.'),
});

const BASE_DESCRIPTION =
  'Delegate one job. Work runs concurrently by default so you can continue your own task; set background=false to wait for the report. ' +
  'New children start without your conversation; include all needed context. Results and useful messages reach you automatically. ' +
  'Keep working while children run, or use wait_agents for event-driven waiting. Do not poll agent list repeatedly. ' +
  'Use resume with agent_id for an explicit follow-up, especially after interruption/restart. ' +
  'Use action=list for live states, stable IDs and pending messages. Idle children make no model calls. ' +
  'send_message queues instructions safely for active children and wakes completed idle children. ' +
  'stop_agent interrupts current work and keeps history; it does not roll back file changes. Children share the workspace and cannot spawn children.';

type ClientFactory = (modelId?: string, reasoningEffort?: ReasoningEffort) => ModelChoice;

export function childTools(mode: Mode, allow?: string[], background = false): Tool[] {
  const offered = toolsFor(mode, background).filter((tool) => ![NAME, 'wait_agents', 'stop_agent'].includes(tool.name));
  if (!allow) return offered;
  return allow
    .map((name) => offered.find((tool) => tool.name === name))
    .filter((tool): tool is Tool => tool !== undefined);
}

export function childHost(host: Host, agentId: string = randomUUID()): {host: Host; events: AgentEvent[]} {
  const events: AgentEvent[] = [];
  return {
    host: {
      ...host,
      agentId,
      signal: host.signal,
      ...(host.onModelUsage
        ? {onModelUsage: (usage) => host.onModelUsage?.(usage)}
        : {}),
      onEvent(event) {
        events.push(event);
        if (['model_attempt', 'model_attempt_start', 'model_retry', 'recovery', 'response_incomplete', 'thinking_delta'].includes(event.type)) host.onDiagnostic?.(event);
      },
      confirm(request) {
        return host.confirm({...request, reason: `sub-agent: ${request.reason}`}, host.signal);
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
  const namedSchema = schema.extend({agent: z.string().optional().describe('The named global agent type for a new child.')});
  const selectedSchema = sorted.length === 0 ? schema : namedSchema;
  const routing = sorted
    .map((definition) => `${definition.name}: ${definition.description}`)
    .join('\n');

  return {
    name: NAME,
    description: routing ? `${BASE_DESCRIPTION}\n\n${routing}` : BASE_DESCRIPTION,
    schema: selectedSchema,
    ...(sorted.length ? {parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['run', 'list'], description: 'Run an assignment (default), or list saved children.'},
        description: {type: 'string', description: DESCRIPTION},
        prompt: {type: 'string', description: PROMPT},
        background: {type: 'boolean', description: BACKGROUND},
        resume: {type: 'string', description: 'The saved agent_id to continue. Omit agent when resuming.'},
        agent: {type: 'string', enum: sorted.map((one) => one.name), description: 'The named global agent type for a new child.'},
      },
      additionalProperties: false,
    }} : {}),
    async run(rawArguments, ctx) {
      const args = selectedSchema.parse(rawArguments) as {
        action?: 'run' | 'list'; description?: string; prompt?: string; resume?: string; agent?: string; background?: boolean;
      };
      if (args.action === 'list') {
        if (args.resume || args.prompt || args.agent || args.background) return {text: 'Error: list does not accept an assignment or agent selection.'};
        if (ctx.agents) return {text: JSON.stringify(ctx.agents.list())};
        if (!ctx.store) return {text: 'No saved subagents: this run has no parent session store.'};
        return {text: JSON.stringify(listSubagents(ctx.store).map((meta) => ({
          agent_id: meta.id, description: meta.description, agent: meta.agent,
          status: meta.status, updated_at: meta.updatedAt,
        })))};
      }
      if (!args.description?.trim() || !args.prompt?.trim()) {
        return {text: 'Error: run requires description and prompt.'};
      }
      const background = args.background ?? true;
      if (background && !ctx.agents) return {text: 'Error: background agents require the main agent runtime.'};
      if (ctx.host.signal.aborted) return {text: INTERRUPTED, failure: true, execution: 'not_started'};
      if (args.resume && ctx.agents?.running(args.resume)) return {text: 'Error: agent already has active work; use send_message to queue instructions.'};
      if (args.resume && args.agent) return {text: 'Error: resume keeps the saved agent type; omit agent.'};
      if (args.resume && !ctx.store) return {text: 'Error: resume requires the saved parent session. Reopen it with /resume.'};
      const saved = args.resume ? loadSubagent(ctx.store!, args.resume) : undefined;
      if (saved && saved.meta.workspace !== ctx.root) return {text: 'Error: subagent belongs to another workspace.'};
      const definition = args.agent
        ? sorted.find((candidate) => candidate.name === args.agent)
        : undefined;
      if (args.agent && !definition) {
        return {text: `Error: unknown agent type '${args.agent}'. Choose one of: ${sorted.map((one) => one.name).join(', ')}.`};
      }
      const model = saved?.meta.modelSettings.model ?? definition?.model;
      const effort = saved?.meta.modelSettings.reasoningEffort ?? ctx.choice?.reasoningEffort;
      let choice = ctx.choice;
      if (model && (model !== choice?.model || (!saved && definition?.model))) {
        try {
          choice = clientFactory(model, effort);
          if (effort !== undefined) choice = {...choice, reasoningEffort: effort};
        } catch (error) {
          return {text: `Error: agent '${saved?.meta.agent ?? definition?.name ?? args.resume}' could not start: ${(error as Error).message}`};
        }
      } else if (choice && saved) {
        choice = {...choice, reasoningEffort: effort};
      }
      if (!choice) return {text: NO_CHOICE};
      const configuredMode = saved?.meta.mode ?? definition?.permissionMode;
      const mode = configuredMode ? stricterMode(ctx.mode, configuredMode) : ctx.mode;
      const sandbox = saved?.meta.sandbox === 'on' || ctx.sandbox === 'on' ? 'on' : ctx.sandbox ?? DEFAULT_SANDBOX;
      const available = childTools(mode, undefined, Boolean(ctx.backgroundTasks));
      const allow = saved?.meta.tools ?? definition?.tools;
      if (allow) {
        const missing = allow.filter((name) => !available.some((tool) => tool.name === name));
        if (missing.length > 0) return {text: `Error: agent '${saved?.meta.agent ?? definition?.name ?? args.resume}' cannot start because these tools are unavailable: ${missing.join(', ')}`};
      }
      const tools = allow ? allow.map((name) => available.find((tool) => tool.name === name)!) : available;
      const role = saved?.meta.role ?? definition?.prompt;
      const rules = saved ? restrictedRules(saved.meta.rules, ctx.rules) : ctx.rules;
      const session = createSession(ctx.root, subagentPrompt(ctx.root, mode, role, sandbox), choice.contextWindow, sandbox);
      session.mode = mode;
      session.rules = rules;
      session.allowed = new Set(ctx.allowed);
      if (saved) {
        restoreMessages(session, saved.messages);
        session.usage = {...saved.meta.usage};
        setMeasured(session, saved.lastUsage?.total ?? 0);
      }
      const before = {...session.usage};
      const previousStatus = saved?.meta.status;
      const persisted = ctx.store ? saved ? openSubagent(ctx.store, saved.meta) : startSubagent(ctx.store, {
        workspace: ctx.root, description: args.description, agent: definition?.name, role,
        tools: tools.map((tool) => tool.name), mode, sandbox, rules,
        modelSettings: modelSettings(choice),
      }) : undefined;
      const agentId = persisted?.meta.id ?? randomUUID();
      if (persisted) {
        persisted.meta.background = background;
        persisted.meta.description = args.description;
        persisted.meta.mode = mode;
        persisted.meta.sandbox = sandbox;
        persisted.meta.rules = rules;
      }
      const execute = async (signal: AbortSignal): Promise<ToolOutput> => {
        const child = childHost({...ctx.host, signal}, agentId);
        if (ctx.agents) child.host.confirm = (request) => ctx.agents!.confirm({...request, reason: `sub-agent: ${request.reason}`}, signal, agentId);
        const backgroundTasks = ctx.backgroundTasks?.fork((event) => {
          child.host.onEvent(event);
          ctx.host.onEvent(event);
        }, signal);
        let unfinished: BackgroundTaskInfo[] = [];
        let failure: string | undefined;
        try {
          if (persisted) {
            persisted.store.seed(session.messages);
            if (saved) {
              const recovery = recoverToolResults(session.messages);
              session.messages = recovery.messages;
              for (const message of recovery.recovered) persisted.store.appendMessage(message);
              if (previousStatus !== 'completed') {
                const notice = {role: 'user' as const, name: 'acc_agent', content: '[runtime: the previous assignment did not complete. Actions may have taken effect. Inspect saved results and current state before repeating any action. Continue only with the new assignment.]'};
                session.messages.push(notice);
                persisted.store.appendMessage(notice);
              }
            }
          }
          if (!ctx.mailboxOnly) {
            const task = addTask(session, args.prompt!);
            if (task.role === 'user') task.name = 'acc_agent';
            persisted?.store.appendMessage(task);
          }
          session.asked = [...(ctx.authorizationTasks ?? [])];
          await runAgent(session, choice!, child.host, tools, persisted?.store, {backgroundTasks, durableTools: Boolean(persisted), agents: ctx.agents, inboxId: agentId});
        } catch (error) {
          failure = (error as Error).message;
        } finally {
          try {
            unfinished = await backgroundTasks?.close('owning subagent finished') ?? [];
          } catch (error) {
            failure = (error as Error).message;
          }
        }
        const status = signal.aborted ? 'interrupted' : failure || child.events.some((event) => event.type === 'error') ? 'failed' : 'completed';
        const result = report(child.events);
        if (status !== 'completed') {
          result.failure = true;
          result.execution = 'uncertain';
        }
        result.usage = {
          prompt: session.usage.prompt - before.prompt,
          completion: session.usage.completion - before.completion,
          total: session.usage.total - before.total,
        };
        if (signal.aborted) result.text = INTERRUPTED;
        if (failure) result.text = `Error: ${failure}`;
        result.text = `agent_id: ${agentId}\nstatus: ${status}${persisted ? '' : ' (not saved; this run has no parent session store)'}\n\n${result.text}`;
        if (unfinished.length > 0) {
          result.text += '\nBackground commands stopped when this subagent finished:\n' +
            unfinished.map((task) => JSON.stringify(task)).join('\n');
        }

        persisted?.finish(status, {text: result.text, failure: result.failure, usage: result.usage});
        return result;
      };
      if (!ctx.agents) return execute(ctx.host.signal);
      if (ctx.store) ctx.agents.onIdle(agentId, () => makeSubagent(definitions, clientFactory).run({resume: agentId, description: args.description, prompt: 'Process queued messages.', background: true}, {...ctx, mailboxOnly: true}));
      const done = ctx.agents.start(agentId, args.description, execute, background, persisted?.meta.assignmentId ?? randomUUID());
      if (background) return {text: `agent_id: ${agentId}\nstatus: running${persisted ? '' : ' (not saved; this run has no parent session store)'}`};
      return done;
    },
  };
}

function restrictedRules(saved: Rules, current: Rules): Rules {
  return {
    allow: saved.allow.filter((one) => current.allow.some((other) => one.tag === other.tag && one.pattern === other.pattern)),
    ask: [...saved.ask, ...current.ask],
    deny: [...saved.deny, ...current.deny],
  };
}

export const subagent: Tool = makeSubagent([]);
