import OpenAI, {type ClientOptions} from 'openai';
import type {Invoke} from './gemini.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function deepseekInvoke(apiKey: string, fetch?: ClientOptions['fetch']): Invoke {
  const client = new OpenAI({apiKey, baseURL: DEEPSEEK_BASE_URL, maxRetries: 0, timeout: 120_000, ...(fetch ? {fetch} : {})});
  return (request, signal) => client.chat.completions.create(
    request as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
    {signal},
  );
}

async function* checkedStream(source: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncGenerator<OpenAI.ChatCompletionChunk> {
  let finished = false;
  let toolCall = false;
  for await (const chunk of source) {
    if (chunk.choices[0]?.delta.tool_calls?.length) toolCall = true;
    const reason = chunk.choices[0]?.finish_reason;
    if (reason === 'length' && toolCall) throw new Error('DeepSeek hit its output limit during a tool call; no tool was executed');
    if (reason) {
      if (!['stop', 'tool_calls', 'length'].includes(reason)) {
        throw new Error(`DeepSeek stopped with status ${reason}`);
      }
      finished = true;
    }
    yield chunk;
  }
  if (!finished) throw new Error('DeepSeek stream ended without a completion');
}

export function deepseekClient(apiKey: string, invoke?: Invoke): OpenAI {
  const call = invoke ?? deepseekInvoke(apiKey);
  const create = async (body: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<unknown> => {
    const request = {
      max_tokens: 32_000,
      reasoning_effort: 'high',
      thinking: {type: 'enabled'},
      ...body,
    };
    const response = await call(request, options?.signal);
    return body.stream ? checkedStream(response as AsyncIterable<OpenAI.ChatCompletionChunk>) : response;
  };
  return {chat: {completions: {create}}} as unknown as OpenAI;
}
