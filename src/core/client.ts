import OpenAI from 'openai';
import {loadEnvFiles} from './env.js';
import type {Host, Usage} from './host.js';
import {withRetry, type RetryOptions} from './retry.js';
import type {ToolDefinition} from './tools/registry.js';

type Provider = {baseUrl: string; keyEnv: string};

const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  glm: {
    baseUrl: 'https://api.z.ai/api/paas/v4/',
    keyEnv: 'GLM_API_KEY',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: 'MOONSHOT_API_KEY',
  },
};

type ModelInfo = {provider: string; label: string; contextWindow: number};

export const MODELS: Record<string, ModelInfo> = {
  'kimi-k3': {provider: 'kimi', label: 'Kimi K3', contextWindow: 1_000_000},
  'kimi-k2.7-code': {
    provider: 'kimi',
    label: 'Kimi K2.7 Code',
    contextWindow: 262_144,
  },
  'deepseek-v4-pro': {
    provider: 'deepseek',
    label: 'DeepSeek v4 Pro',
    contextWindow: 1_000_000,
  },
  'deepseek-v4-flash': {
    provider: 'deepseek',
    label: 'DeepSeek v4 Flash',
    contextWindow: 1_000_000,
  },
  'glm-5.2': {provider: 'glm', label: 'GLM 5.2', contextWindow: 1_000_000},
  'glm-4.7-flash': {
    provider: 'glm',
    label: 'GLM 4.7 Flash',
    contextWindow: 200_000,
  },
};

export const MAX_OUTPUT_TOKENS = 32_000;

export type ModelChoice = {
  client: OpenAI;
  model: string;
  label: string;
  contextWindow: number;
};

export const DEFAULT_MODEL = 'deepseek-v4-flash';

function hasKey(id: string, env: NodeJS.ProcessEnv): boolean {
  const info = MODELS[id];
  return info ? Boolean(env[PROVIDERS[info.provider]!.keyEnv]) : false;
}

export function chooseModel(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACC_MODEL;
  if (explicit) return explicit;
  if (hasKey(DEFAULT_MODEL, env)) return DEFAULT_MODEL;
  return Object.keys(MODELS).find((id) => hasKey(id, env)) ?? DEFAULT_MODEL;
}

export function createClient(modelId?: string): ModelChoice {
  loadEnvFiles();
  const resolved = modelId ?? chooseModel();
  const info = MODELS[resolved];
  if (!info) {
    throw new Error(
      `Unknown model '${resolved}'. Choose one of: ${Object.keys(MODELS).join(', ')}.`,
    );
  }
  const provider = PROVIDERS[info.provider]!;
  const apiKey = process.env[provider.keyEnv];
  if (!apiKey) {
    throw new Error(`${provider.keyEnv} is not set — needed for ${info.label}.`);
  }
  return {
    client: new OpenAI({apiKey, baseURL: provider.baseUrl}),
    model: resolved,
    label: info.label,
    contextWindow: info.contextWindow,
  };
}

export type RawToolCall = {id: string; name: string; args: string};

export type AssistantTurn = {
  content: string;
  toolCalls: RawToolCall[];
  finishReason: string;
  usage: Usage;
};

export class StreamFailure extends Error {
  readonly partial: AssistantTurn;

  constructor(message: string, partial: AssistantTurn, cause?: unknown) {
    super(message, {cause});
    this.name = 'StreamFailure';
    this.partial = partial;
  }
}

async function attemptTurn(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
): Promise<AssistantTurn> {
  let content = '';
  let finishReason = 'stop';
  let emitted = false;
  const calls: RawToolCall[] = [];
  const usage: Usage = {prompt: 0, completion: 0, total: 0};
  const soFar = (): AssistantTurn => ({
    content,
    toolCalls: calls.filter(Boolean),
    finishReason,
    usage,
  });

  try {
    const stream = await choice.client.chat.completions.create(
      {
        model: choice.model,
        messages,
        tools: toolDefs as OpenAI.ChatCompletionTool[],
        stream: true,
        stream_options: {include_usage: true},
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      {signal: host.signal},
    );

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.prompt = chunk.usage.prompt_tokens ?? 0;
        usage.completion = chunk.usage.completion_tokens ?? 0;
        usage.total = chunk.usage.total_tokens ?? 0;
      }
      const choiceChunk = chunk.choices[0];
      if (!choiceChunk) continue;
      if (choiceChunk.finish_reason) finishReason = choiceChunk.finish_reason;
      const delta = choiceChunk.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        emitted = true;
        host.onEvent({type: 'text_delta', text: delta.content});
      }
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index] ??= {id: '', name: '', args: ''});
        emitted = true;
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name = part.function.name;
        if (part.function?.arguments) call.args += part.function.arguments;
      }
    }
  } catch (error) {
    if (!emitted) throw error;
    const message =
      (error as Error)?.message || 'the stream ended before the answer did';
    throw new StreamFailure(message, soFar(), error);
  }

  return soFar();
}

export async function streamTurn(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
  retry: Partial<RetryOptions> = {},
): Promise<AssistantTurn> {
  return withRetry(() => attemptTurn(choice, messages, toolDefs, host), {
    signal: host.signal,
    ...retry,
  });
}
