import type {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {ModelChoice} from '../client.js';
import {INTERRUPTED, type DiffPayload, type Host, type Usage} from '../host.js';
import {approvalKey, decide, type Request} from '../permission/decide.js';
import type {Mode} from '../permission/mode.js';
import type {SandboxMode} from '../sandbox/mode.js';
import type {Rules} from '../settings.js';
import {insideRoot, isProtectedPath} from '../permission/protected.js';
import {absoluteTarget, accessReason, hasAccess, normalizeAccess, type SandboxAccess} from '../sandbox/policy.js';
import {fileOperation} from '../sandbox/files.js';
import {resolveTarget} from './paths.js';

export type Judge = (
  request: Request,
  reason: string,
) => Promise<'allow' | 'ask'>;

export type ToolContext = {
  root: string;
  host: Host;
  allowed: Set<string>;
  rules: Rules;
  mode: Mode;
  sandbox?: SandboxMode;
  choice?: ModelChoice;
  backup?: (path: string, snapshot: Buffer | null) => void;
  judge?: Judge;
  denied?: string[];
  sandboxAccess?: SandboxAccess;
};

export type ToolOutput = {text: string; diff?: DiffPayload | null; usage?: Usage};

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  parameters?: Record<string, unknown>;
  request?: (args: unknown) => Request;
  access?: (args: unknown) => SandboxAccess;
  run: (args: unknown, ctx: ToolContext) => Promise<ToolOutput>;
};

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

function jsonSchemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'openApi3',
  }) as Record<string, unknown>;
  delete converted.$schema;
  return converted;
}

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const schema = tool.parameters ?? jsonSchemaOf(tool.schema);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schema,
      },
    };
  });
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
}

export const DENIED =
  'the user refused this command. do not retry it and do not look for ' +
  'another way to do the same thing. carry on with the rest of the task ' +
  'if there is one, then tell the user what you could not do.';

type Permission = {denied?: string; interrupted?: true; args: unknown; access?: SandboxAccess};

function approved(request: Request, args: unknown, command?: string): Permission {
  return {args: request.kind === 'command' && command ? {...(args as object), command} : args};
}

async function permitted(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
): Promise<Permission> {
  if (ctx.host.signal.aborted) return {interrupted: true, args};
  if (!tool.request) return {args};
  const request = tool.request(args);
  const outcome = decide(request, ctx.root, ctx.rules, ctx.mode);
  if (outcome.decision === 'deny') return {denied: outcome.reason, args};
  let access: SandboxAccess = {};
  if (ctx.sandbox === 'on') {
    access = tool.access?.(args) ?? {};
    if (request.kind !== 'command') {
      const target = absoluteTarget(ctx.root, request.path);
      normalizeAccess(ctx.root, {read_paths: [request.path]});
      if (!insideRoot(target, ctx.root) || (request.kind === 'write' && isProtectedPath(target, ctx.root))) {
        access = request.kind === 'read' ? {read_paths: [request.path]} : {write_paths: [request.path]};
      }
    }
    access = normalizeAccess(ctx.root, access);
  }
  if (hasAccess(access)) {
    const decision = await ctx.host.confirm({
      command: outcome.command ?? `${tool.name} ${describe(request)}`,
      reason: `${outcome.reason ? `${outcome.reason}. ` : ''}${accessReason(access)}`,
      suppressible: false,
    });
    if (ctx.host.signal.aborted) return {interrupted: true, args};
    if (decision === 'deny') {
      ctx.denied?.push(outcome.command ?? describe(request));
      return {denied: DENIED, args};
    }
    return {...approved(request, args, outcome.command), access};
  }
  if (outcome.decision === 'allow') return approved(request, args, outcome.command);
  const key = approvalKey(request);
  if (ctx.allowed.has(key)) return approved(request, args, outcome.command);
  if (outcome.decision === 'judge' && ctx.judge) {
    const verdict = await ctx
      .judge(judged(request, outcome.command), outcome.reason)
      .catch(() => 'ask' as const);
    if (ctx.host.signal.aborted) return {interrupted: true, args};
    if (verdict === 'allow') return approved(request, args, outcome.command);
  }
  const decision = await ctx.host.confirm({
    command: outcome.command ?? `${tool.name} ${describe(request)}`,
    reason: outcome.reason,
    suppressible: outcome.suppressible,
  });
  if (ctx.host.signal.aborted) return {interrupted: true, args};
  if (decision === 'deny') {
    ctx.denied?.push(outcome.command ?? describe(request));
    return {denied: DENIED, args};
  }
  if (decision === 'session' && outcome.suppressible) ctx.allowed.add(key);
  return approved(request, args, outcome.command);
}

function describe(request: Request): string {
  if (request.kind === 'command') return request.command;
  return request.path;
}

function judged(request: Request, command?: string): Request {
  return request.kind === 'command' && command ? {...request, command} : request;
}

export async function runTool(
  tools: Tool[],
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return {text: `Error: unknown tool '${name}'`};
  }
  let args: unknown;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch (error) {
    return {
      text:
        `Error: the arguments were not valid JSON (${(error as Error).message}). ` +
        'Send the arguments again as a single JSON object.',
    };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return {text: `Error: invalid arguments: ${issues(parsed.error)}`};
  }
  try {
    const permission = await permitted(tool, parsed.data, ctx);
    if (permission.interrupted) return {text: INTERRUPTED};
    if (permission.denied) return {text: `Error: ${permission.denied}`};
    const execution = {...ctx, sandboxAccess: permission.access};
    if (ctx.backup && tool.request) {
      const request = tool.request(parsed.data);
      if (request.kind === 'write') {
        const snapshot = await fileOperation({kind: 'snapshot', target: resolveTarget(ctx.root, request.path)}, execution);
        try { ctx.backup(request.path, snapshot.bytes === null ? null : Buffer.from(snapshot.bytes, 'base64')); } catch {}
      }
    }
    return await tool.run(permission.args, execution);
  } catch (error) {
    if (ctx.host.signal.aborted) return {text: INTERRUPTED};
    return {text: `Error: ${(error as Error).message}`};
  }
}
