import type OpenAI from 'openai';
import {deepseekClient, DEEPSEEK_BASE_URL} from './deepseek.js';
import {geminiClient} from './gemini.js';
import {loadEnvFiles} from './env.js';
import {relayInvoke} from './model-relay-client.js';
import type {Host, ModelTokenUsage, Usage} from './host.js';
import type {AssistantContinuation} from './messages.js';
import {
  DEFAULT_MODEL,
  JUDGE_MODEL,
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  type ReasoningEffort,
  MODELS,
  MODEL_IDS,
  PROVIDERS,
} from './models.js';
import {withRetry, type RetryOptions} from './retry.js';
import {modelOf, reasoningOf} from './settings.js';
import type {ToolDefinition} from './tools/registry.js';

export {DEFAULT_MODEL, MODELS} from './models.js';

export function judgeModelFor(_model?: string): string {
  return JUDGE_MODEL;
}

export function createJudgeClient(): ModelChoice {
  const relay = process.env.ACC_MODEL_RELAY_URL;
  if (!relay) loadEnvFiles();
  const key = process.env.GEMINI_API_KEY;
  if (!relay && !key) throw new Error('GEMINI_API_KEY is not set — needed for the permission judge.');
  return {
    client: geminiClient(key ?? '', relay ? relayInvoke(relay) : undefined),
    model: JUDGE_MODEL,
    label: 'Gemini 3.5 Flash-Lite',
    contextWindow: 1_048_576,
  };
}

export function chooseReasoning(
  env: NodeJS.ProcessEnv = process.env,
  saved: ReasoningEffort | null = reasoningOf(),
): ReasoningEffort {
  const value = env.ACC_REASONING_EFFORT ?? saved ?? DEFAULT_REASONING_EFFORT;
  if (!isReasoningEffort(value)) throw new Error('ACC_REASONING_EFFORT must be none, low, high, or max.');
  return value;
}

export const MAX_OUTPUT_TOKENS = 32_000;
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The model did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds`);
    this.name = 'ModelTimeoutError';
  }
}

export type ModelChoice = {
  client: OpenAI;
  model: string;
  label: string;
  contextWindow: number;
  reasoningEffort?: ReasoningEffort;
};

export type ModelSettings = {
  provider: string;
  baseURL: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  thinking: 'enabled' | 'disabled';
  maxOutputTokens: number;
  requestTimeoutMs: number;
};

export function modelSettings(choice: Pick<ModelChoice, 'model' | 'reasoningEffort'>): ModelSettings {
  const reasoningEffort = choice.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  return {
    provider: MODELS[choice.model]?.provider ?? 'unknown',
    baseURL: DEEPSEEK_BASE_URL,
    model: choice.model,
    reasoningEffort,
    thinking: reasoningEffort === 'none' ? 'disabled' : 'enabled',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    requestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
  };
}

export function chooseModel(
  env: NodeJS.ProcessEnv = process.env,
  saved: string | null = modelOf(),
): string {
  const explicit = env.ACC_MODEL;
  if (explicit) return explicit;
  if (saved) return saved;
  return DEFAULT_MODEL;
}

export function createClient(modelId?: string, reasoningEffort?: ReasoningEffort): ModelChoice {
  const relay = process.env.ACC_MODEL_RELAY_URL;
  if (!relay) loadEnvFiles();
  const resolved = modelId ?? chooseModel();
  const info = MODELS[resolved];
  if (!info) {
    throw new Error(
      `Unknown coding model '${resolved}'. Gemini coding models have been replaced; use ${MODEL_IDS.join(', ')}.`,
    );
  }
  const provider = PROVIDERS[info.provider]!;
  const apiKey = process.env[provider.keyEnv];
  if (!relay && !apiKey) {
    throw new Error(`${provider.keyEnv} is not set — needed for ${info.label}.`);
  }
  return {
    client: deepseekClient(apiKey ?? '', relay ? relayInvoke(relay) : undefined),
    reasoningEffort: reasoningEffort ?? chooseReasoning(),
    model: resolved,
    label: info.label,
    contextWindow: info.contextWindow,
  };
}

export type RawToolCall = {id: string; name: string; args: string};

export type AssistantResponse = {
  content: string;
  continuation?: AssistantContinuation;
  toolCalls: RawToolCall[];
  finishReason: string;
  usage: Usage;
};

type ProviderUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  prompt_tokens_details?: {cached_tokens?: unknown} | null;
};

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function modelTokenUsage(usage: ProviderUsage): ModelTokenUsage {
  const inputTokens = tokenCount(usage.prompt_tokens);
  const outputTokens = tokenCount(usage.completion_tokens);
  const totalTokens = tokenCount(usage.total_tokens);
  const detailedCacheHits = tokenCount(
    usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheHitInputTokens =
    typeof usage.prompt_cache_hit_tokens === 'number'
      ? tokenCount(usage.prompt_cache_hit_tokens)
      : detailedCacheHits;
  const cacheMissInputTokens =
    typeof usage.prompt_cache_miss_tokens === 'number'
      ? tokenCount(usage.prompt_cache_miss_tokens)
      : Math.max(0, inputTokens - cacheHitInputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitInputTokens,
    cacheMissInputTokens,
  };
}

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
  signal: AbortSignal,
  isActive: () => boolean,
): Promise<AssistantResponse> {
  let content = '';
  let reasoningContent: string | undefined;
  let finishReason = 'stop';
  let emitted = false;
  let providerUsage: ModelTokenUsage | null = null;
  const calls: RawToolCall[] = [];
  const usage: Usage = {prompt: 0, completion: 0, total: 0};
  const soFar = (): AssistantResponse => ({
    content,
    ...(reasoningContent === undefined
      ? {}
      : {
          continuation: {
            kind: 'reasoning_content' as const,
            content: reasoningContent,
          },
        }),
    toolCalls: calls.filter(Boolean),
    finishReason,
    usage,
  });

  try {
    const stream = await choice.client.chat.completions.create(
      {
        model: choice.model,
        ...(choice.model === DEFAULT_MODEL ? {
          reasoning_effort: choice.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          thinking: {type: choice.reasoningEffort === 'none' ? 'disabled' : 'enabled'},
        } : {}),
        messages: choice.model === DEFAULT_MODEL ? messages.map((message) =>
          message.role === 'assistant'
            ? {...message, reasoning_content: (message as {reasoning_content?: string}).reasoning_content ?? ''}
            : message,
        ) : messages,
        ...(toolDefs.length ? {tools: toolDefs as OpenAI.ChatCompletionTool[]} : {}),
        stream: true,
        stream_options: {include_usage: true},
        max_tokens: MAX_OUTPUT_TOKENS,
      } as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      {signal},
    );
    if (!isActive()) throw new DOMException('The request was interrupted', 'AbortError');

    for await (const chunk of stream) {
      if (!isActive()) throw new DOMException('The request was interrupted', 'AbortError');
      if (chunk.usage) {
        usage.prompt = chunk.usage.prompt_tokens ?? 0;
        usage.completion = chunk.usage.completion_tokens ?? 0;
        usage.total = chunk.usage.total_tokens ?? 0;
        providerUsage = modelTokenUsage(chunk.usage as ProviderUsage);
      }
      const choiceChunk = chunk.choices[0];
      if (!choiceChunk) continue;
      if (choiceChunk.finish_reason) finishReason = choiceChunk.finish_reason;
      const delta = choiceChunk.delta;
      if (!delta) continue;
      const reasoning = (delta as {reasoning_content?: unknown}).reasoning_content;
      if (typeof reasoning === 'string') {
        reasoningContent = (reasoningContent ?? '') + reasoning;
        emitted = true;
      }
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
    if (providerUsage) host.onModelUsage?.(providerUsage);
    if (!emitted) throw error;
    const message =
      (error as Error)?.message || 'the stream ended before the answer did';
    throw new StreamFailure(message, soFar(), error);
  }

  if (providerUsage) host.onModelUsage?.(providerUsage);

  return soFar();
}

export async function streamStep(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
  retry: Partial<RetryOptions> & {timeoutMs?: number} = {},
): Promise<AssistantResponse> {
  const {timeoutMs = MODEL_REQUEST_TIMEOUT_MS, ...retryOptions} = retry;
  return withRetry(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([host.signal, controller.signal]);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        abortTimer = setTimeout(
          () => reject(new DOMException('The request was interrupted', 'AbortError')),
          50,
        );
      };
      if (host.signal.aborted) {
        onAbort();
        return;
      }
      host.signal.addEventListener('abort', onAbort, {once: true});
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        timeoutTimer = setTimeout(() => reject(new ModelTimeoutError(timeoutMs)), 50);
      }, timeoutMs);
    });
    return Promise.race([attemptStep(choice, messages, toolDefs, host, signal, () => active), deadline])
      .catch((error: unknown) => {
        if (!timedOut) throw error;
        const timeout = new ModelTimeoutError(timeoutMs);
        if (error instanceof StreamFailure) {
          throw new StreamFailure(timeout.message, error.partial, timeout);
        }
        throw timeout;
      })
      .finally(() => {
        active = false;
        if (timer) clearTimeout(timer);
        if (abortTimer) clearTimeout(abortTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (onAbort) host.signal.removeEventListener('abort', onAbort);
      });
  }, {
    signal: host.signal,
    ...retryOptions,
    onRetry: (attempt, total) => {
      host.onEvent({type: 'model_retry', attempt, total});
      retryOptions.onRetry?.(attempt, total);
    },
  });
}
