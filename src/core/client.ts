import OpenAI from 'openai';
import {loadEnvFiles} from './env.js';
import type {Host, Usage} from './host.js';
import {
  DEFAULT_MODEL,
  JUDGE_MODELS,
  MODELS,
  MODEL_IDS,
  PROVIDERS,
  hasKey,
} from './models.js';
import {withRetry, type RetryOptions} from './retry.js';
import {modelOf} from './settings.js';
import type {ToolDefinition} from './tools/registry.js';

export {DEFAULT_MODEL, MODELS} from './models.js';

export function judgeModelFor(model: string): string {
  const info = MODELS[model];
  if (!info) return model;
  return JUDGE_MODELS[info.provider] ?? model;
}

export const MAX_OUTPUT_TOKENS = 32_000;

export type ModelChoice = {
  client: OpenAI;
  model: string;
  label: string;
  contextWindow: number;
};

export function chooseModel(
  env: NodeJS.ProcessEnv = process.env,
  saved: string | null = modelOf(),
): string {
  const explicit = env.ACC_MODEL;
  if (explicit) return explicit;
  if (saved) return saved;
  if (hasKey(DEFAULT_MODEL, env)) return DEFAULT_MODEL;
  return MODEL_IDS.find((id) => hasKey(id, env)) ?? DEFAULT_MODEL;
}

export function createClient(modelId?: string): ModelChoice {
  loadEnvFiles();
  const resolved = modelId ?? chooseModel();
  const info = MODELS[resolved];
  if (!info) {
    throw new Error(
      `Unknown model '${resolved}'. Choose one of: ${MODEL_IDS.join(', ')}.`,
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

export type AssistantResponse = {
  content: string;
  toolCalls: RawToolCall[];
  finishReason: string;
  usage: Usage;
};

export class StreamFailure extends Error {
  readonly partial: AssistantResponse;

  constructor(message: string, partial: AssistantResponse, cause?: unknown) {
    super(message, {cause});
    this.name = 'StreamFailure';
    this.partial = partial;
  }
}

async function attemptStep(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
): Promise<AssistantResponse> {
  let content = '';
  let finishReason = 'stop';
  let emitted = false;
  const calls: RawToolCall[] = [];
  const usage: Usage = {prompt: 0, completion: 0, total: 0};
  const soFar = (): AssistantResponse => ({
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

export async function streamStep(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
  retry: Partial<RetryOptions> = {},
): Promise<AssistantResponse> {
  return withRetry(() => attemptStep(choice, messages, toolDefs, host), {
    signal: host.signal,
    ...retry,
  });
}
