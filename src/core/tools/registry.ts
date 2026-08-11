import type {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {ConfirmRequest, DiffPayload, Host} from '../host.js';
import {approvalKey, decide} from '../policy.js';

export type ToolContext = {
  root: string;
  host: Host;
  allowed: Set<string>;
};

export type ToolOutput = {text: string; diff?: DiffPayload | null};

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  confirm?: (args: unknown) => ConfirmRequest;
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

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const schema = zodToJsonSchema(tool.schema, {
      $refStrategy: 'none',
      target: 'openApi3',
    }) as Record<string, unknown>;
    delete schema.$schema;
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

async function permitted(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
): Promise<string | null> {
  if (decide(tool.name) === 'allow' || !tool.confirm) return null;
  const request = tool.confirm(args);
  const key = approvalKey(request.command);
  if (ctx.allowed.has(key)) return null;
  const decision = await ctx.host.confirm(request);
  if (decision === 'deny') {
    return 'user denied this command; try another approach';
  }
  if (decision === 'session') ctx.allowed.add(key);
  return null;
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
    const denied = await permitted(tool, parsed.data, ctx);
    if (denied) return {text: `Error: ${denied}`};
    return await tool.run(parsed.data, ctx);
  } catch (error) {
    return {text: `Error: ${(error as Error).message}`};
  }
}
