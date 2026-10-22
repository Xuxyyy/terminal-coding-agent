import OpenAI, {type ClientOptions} from 'openai';
import {MAX_OUTPUT_TOKENS} from './models.js';
export type RequestMetadata = {requestId?: string; agentId?: string; attempt?: number};
export type Invoke = (request: Record<string, unknown>, signal?: AbortSignal, metadata?: RequestMetadata) => Promise<unknown>;

export function metadataHeaders(metadata?: RequestMetadata): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [`x-acc-${key.toLowerCase()}`, String(value)]));
}

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function deepseekInvoke(apiKey: string, fetch?: ClientOptions['fetch']): Invoke {
  const client = new OpenAI({apiKey, baseURL: DEEPSEEK_BASE_URL, maxRetries: 0, timeout: 2_147_000_000, ...(fetch ? {fetch} : {})});
  return (request, signal, metadata) => client.chat.completions.create(
    request as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
    {signal, headers: metadataHeaders(metadata)},
  );
}

async function* checkedStream(source: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncGenerator<OpenAI.ChatCompletionChunk> {
  let finished = false;
  for await (const chunk of source) {
    const reason = chunk.choices[0]?.finish_reason;
    if (reason) {
      if (!['stop', 'tool_calls', 'length'].includes(reason)) {
        throw new Error(`DeepSeek stopped with status ${reason}`);
      }
      finished = true;
    }
    yield chunk;
  }
  if (!finished) throw Object.assign(new Error('DeepSeek stream ended without a completion'), {code: 'INCOMPLETE_RESPONSE'});
}

export function deepseekClient(apiKey: string, invoke?: Invoke): OpenAI {
  const call = invoke ?? deepseekInvoke(apiKey);
  const create = async (body: Record<string, unknown>, options?: {signal?: AbortSignal; headers?: Record<string, string>}): Promise<unknown> => {
    const request = {
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: 'high',
      thinking: {type: 'enabled'},
      ...body,
    };
    const response = await call(request, options?.signal, {requestId: options?.headers?.['x-acc-requestid'], agentId: options?.headers?.['x-acc-agentid'], attempt: options?.headers?.['x-acc-attempt'] ? Number(options.headers['x-acc-attempt']) : undefined});
    return body.stream ? checkedStream(response as AsyncIterable<OpenAI.ChatCompletionChunk>) : response;
  };
  return {chat: {completions: {create}}} as unknown as OpenAI;
}
