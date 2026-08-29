import {z} from 'zod';
import type {Tool} from '../tools/registry.js';

export type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ContentBlock = {type: string; text?: string};

export type CallResult = {content?: ContentBlock[]; isError?: boolean};

export type CallTool = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<CallResult>;

export const NO_OUTPUT = '(no output)';

export function toolName(label: string, remote: string): string {
  return `mcp__${label}__${remote}`;
}

function flatten(content: ContentBlock[] | undefined): string {
  const text = (content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return text === '' ? NO_OUTPUT : text;
}

export function adaptTool(
  label: string,
  remote: RemoteTool,
  call: CallTool,
): Tool {
  return {
    name: toolName(label, remote.name),
    description: remote.description ?? '',
    schema: z.record(z.unknown()),
    parameters: remote.inputSchema,
    request: () => ({kind: 'mcp', server: label, tool: remote.name}),
    run: async (args, ctx) => {
      const result = await call(remote.name, args, ctx.host.signal);
      const text = flatten(result.content);
      if (result.isError) throw new Error(text);
      return {text};
    },
  };
}
