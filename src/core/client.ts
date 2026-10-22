import type OpenAI from 'openai';
import {randomUUID} from 'node:crypto';
import {deepseekClient, DEEPSEEK_BASE_URL, metadataHeaders, type RequestMetadata} from './deepseek.js';
import {loadEnvFiles} from './env.js';
import {relayInvoke} from './model-relay-client.js';
import type {Host, ModelTokenUsage, Usage} from './host.js';
import type {AssistantContinuation} from './messages.js';
import {
  DEFAULT_MODEL,
  JUDGE_MODEL,
  MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  type ReasoningEffort,
  MODELS,
  MODEL_IDS,
  PROVIDERS,
} from './models.js';
import {withRetry, RecoveryExhaustedError, errorCategory, type RetryOptions} from './retry.js';
import {decideRecovery, type RecoveryAllowances} from './recovery.js';
import {modelOf, reasoningOf} from './settings.js';
import type {ToolDefinition} from './tools/registry.js';

export {DEFAULT_MODEL, MAX_OUTPUT_TOKENS, MODELS} from './models.js';

export function judgeModelFor(_model?: string): string {
  return JUDGE_MODEL;
}

export function createJudgeClient(): ModelChoice {
  const relay = process.env.ACC_MODEL_RELAY_URL;
  if (!relay) loadEnvFiles();
  const key = process.env.DEEPSEEK_API_KEY;
  if (!relay && !key) throw new Error('DEEPSEEK_API_KEY is not set — needed for the permission judge.');
  return {
    client: deepseekClient(key ?? '', relay ? relayInvoke(relay) : undefined),
    model: JUDGE_MODEL,
    label: MODELS[JUDGE_MODEL]!.label,
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

export const MODEL_REQUEST_TIMEOUT_MS = 120_000;
export const MODEL_IDLE_TIMEOUT_MS = 60_000;

export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number, readonly phase: 'startup' | 'idle' = 'startup') {
    super(`Model ${phase} timeout after ${Math.ceil(timeoutMs / 1_000)} seconds without meaningful output`);
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
  startupTimeoutMs: number;
  idleTimeoutMs: number;
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
    startupTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    idleTimeoutMs: MODEL_IDLE_TIMEOUT_MS,
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
      `Unknown coding model '${resolved}'; use ${MODEL_IDS.join(', ')}.`,
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
  toolCallDrafts?: RawToolCall[];
  finishReason: string;
  usage: Usage;
  reportedUsage?: ModelTokenUsage | null;
  missingUsageFields?: string[];
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
  progress: () => void,
  completed: () => void,
  snapshot: (response: AssistantResponse) => void,
  metadata: Required<RequestMetadata>,
): Promise<AssistantResponse> {
  let content = '';
  let reasoningContent: string | undefined;
  let finishReason = '';
  let missingUsageFields: string[] = [];
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
    toolCalls: finishReason === 'length' ? [] : calls.filter(Boolean),
    ...(finishReason === 'length' && calls.length
      ? {toolCallDrafts: calls.filter(Boolean)}
      : {}),
    finishReason,
    usage,
    reportedUsage: providerUsage,
    missingUsageFields,
  });
  snapshot(soFar());

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
      {signal, headers: metadataHeaders(metadata)},
    );
    if (!isActive()) throw new DOMException('The request was interrupted', 'AbortError');

    for await (const chunk of stream) {
      if (!isActive()) throw new DOMException('The request was interrupted', 'AbortError');
      if (chunk.usage) {
        usage.prompt = chunk.usage.prompt_tokens ?? 0;
        usage.completion = chunk.usage.completion_tokens ?? 0;
        usage.total = chunk.usage.total_tokens ?? 0;
        providerUsage = modelTokenUsage(chunk.usage as ProviderUsage);
        missingUsageFields = ['prompt_tokens', 'completion_tokens', 'total_tokens'].filter((key) => typeof (chunk.usage as unknown as Record<string, unknown>)[key] !== 'number');
        const raw = chunk.usage as ProviderUsage;
        if (typeof raw.prompt_cache_hit_tokens !== 'number' && typeof raw.prompt_tokens_details?.cached_tokens !== 'number') missingUsageFields.push('cacheHitInputTokens');
        snapshot(soFar());
      }
      const choiceChunk = chunk.choices[0];
      if (!choiceChunk) continue;
      if (choiceChunk.finish_reason) finishReason = choiceChunk.finish_reason;
      const delta = choiceChunk.delta ?? {};
      const reasoning = (delta as {reasoning_content?: unknown}).reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        progress();
        reasoningContent = (reasoningContent ?? '') + reasoning;
        emitted = true;
        host.onEvent({type: 'thinking_delta', text: reasoning, ...metadata});
      }
      if (delta.content) {
        progress();
        content += delta.content;
        emitted = true;
        snapshot(soFar());
        host.onEvent({type: 'text_delta', text: delta.content});
      }
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index] ??= {id: '', name: '', args: ''});
        if (part.id || part.function?.name || part.function?.arguments) { emitted = true; progress(); }
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name = part.function.name;
        if (part.function?.arguments) call.args += part.function.arguments;
      }
      snapshot(soFar());
      if (finishReason) {
        validateResponse(soFar());
        completed();
      }
    }
    validateResponse(soFar());
  } catch (error) {
    snapshot(soFar());
    if (['stop', 'tool_calls', 'length'].includes(finishReason)) {
      try { validateResponse(soFar()); return soFar(); } catch {}
    }
    if (!emitted) throw error;
    const message =
      (error as Error)?.message || 'the stream ended before the answer did';
    throw new StreamFailure(message, soFar(), error);
  }

  return soFar();
}

export class IncompleteResponseError extends Error {
  readonly code = 'INCOMPLETE_RESPONSE';
}

function validateResponse(response: AssistantResponse): void {
  const {finishReason, toolCalls} = response;
  if (!['stop', 'tool_calls', 'length'].includes(finishReason)) throw new IncompleteResponseError('Model stream ended without a valid completion');
  if (toolCalls.length) {
    if (finishReason !== 'tool_calls' || toolCalls.some((call) => !call.id || !call.name) || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
      throw new IncompleteResponseError('Model returned incomplete tool calls; no tool was executed');
    }
  } else if (finishReason === 'tool_calls') {
    throw new IncompleteResponseError('Model completed a tool response without tool calls');
  }
}

export async function streamStep(
  choice: ModelChoice,
  messages: OpenAI.ChatCompletionMessageParam[],
  toolDefs: ToolDefinition[],
  host: Host,
  retry: Partial<RetryOptions> & {timeoutMs?: number; idleTimeoutMs?: number; requestId?: string; recovery?: RecoveryAllowances} = {},
): Promise<AssistantResponse> {
  const {timeoutMs = MODEL_REQUEST_TIMEOUT_MS, idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS, requestId = randomUUID(), recovery = {continuationUsed: false, contextRecovered: false}, ...retryOptions} = retry;
  const budget = retryOptions.budget ?? {attempts: 0};
  return withRetry(async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([host.signal, controller.signal]);
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const agentId = host.agentId ?? 'main';
    const attempt = budget.attempts;
    host.onEvent({type: 'model_attempt_start', requestId, agentId, attempt, startedAt});
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    let phase: 'startup' | 'idle' = 'startup';
    let partial: AssistantResponse = {content: '', toolCalls: [], finishReason: '', usage: {prompt: 0, completion: 0, total: 0}, reportedUsage: null};
    let rejectAttempt: (error: unknown) => void;
    let resolveComplete: (response: AssistantResponse) => void;
    let failure: unknown;
    const stopped = new Promise<never>((_resolve, reject) => { rejectAttempt = reject; });
    const completion = new Promise<AssistantResponse>((resolve) => { resolveComplete = resolve; });
    const fail = (error: unknown) => {
      failure = error;
      active = false;
      controller.abort(error);
      rejectAttempt(partial.content || partial.toolCalls.length || partial.continuation
        ? new StreamFailure((error as Error).message, partial, error) : error);
    };
    const abort = () => fail(host.signal.reason ?? new DOMException('Interrupted', 'AbortError'));
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new ModelTimeoutError(ms, phase)), ms);
    };
    host.signal.addEventListener('abort', abort, {once: true});
    arm(timeoutMs);
    if (host.signal.aborted) abort();
    let result: AssistantResponse | undefined;
    try {
      result = await Promise.race([
        attemptStep(choice, messages, toolDefs, host, signal, () => active,
          () => { if (!completionTimer) { phase = 'idle'; arm(idleTimeoutMs); } },
          () => {
            clearTimeout(timer);
            if (!completionTimer) completionTimer = setTimeout(() => resolveComplete(partial), 50);
          },
          (value) => { partial = value; }, {requestId, agentId, attempt}),
        stopped, completion,
      ]);
      return result;
    } catch (error) {
      failure = error instanceof StreamFailure ? error.cause ?? error : error;
      throw error;
    } finally {
      active = false;
      clearTimeout(timer);
      clearTimeout(completionTimer);
      host.signal.removeEventListener('abort', abort);
      controller.abort();
      const usage = partial.reportedUsage ?? null;
      if (usage) host.onModelUsage?.(usage);
      host.onEvent({type: 'model_attempt', evidence: {
        requestId, agentId, attempt, startedAt, elapsedMs: performance.now() - started,
        outcome: result ? (result.finishReason === 'length' ? 'incomplete' : 'completed') : 'failed',
        ...(failure ? {category: errorCategory(failure)} : {}),
        ...(failure instanceof ModelTimeoutError ? {timeoutPhase: failure.phase} : {}),
        usage, missingUsageFields: partial.missingUsageFields,
        ...(!result || result.finishReason === 'length' ? {partial: {content: partial.content, toolCalls: partial.toolCallDrafts ?? partial.toolCalls, reasoning: partial.continuation?.content}} : {}),
      }});
    }
  }, {
    ...retryOptions, budget, signal: host.signal,
    shouldRetry: (error) => {
      const decision = decideRecovery({kind: 'failure', error, partial: error instanceof StreamFailure ? error.partial : undefined}, {
        ...recovery, attempts: budget.attempts, retries: retryOptions.retries, aborted: host.signal.aborted,
      });
      if (decision.action === 'stop' && decision.reason === 'attempts_exhausted') {
        throw new RecoveryExhaustedError(budget.attempts, error);
      }
      return decision.action === 'retry';
    },
    onRetry: (attempt, total, delayMs) => {
      host.onEvent({type: 'model_retry', attempt, total, delayMs, requestId});
      retryOptions.onRetry?.(attempt, total, delayMs);
    },
  });
}
