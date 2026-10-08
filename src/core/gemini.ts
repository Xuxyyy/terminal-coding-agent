import {GoogleGenAI} from '@google/genai';
import type OpenAI from 'openai';

export const GEMINI_STEPS_PREFIX = 'gemini-interaction-steps:';

type Message = OpenAI.ChatCompletionMessageParam;
type Body = {
  model: string;
  messages: Message[];
  tools?: OpenAI.ChatCompletionTool[];
  stream?: boolean;
  max_tokens?: number;
};
type Step = Record<string, unknown> & {type: string};
type Event = Record<string, unknown> & {event_type?: string; index?: number};
export type Invoke = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textContent(text: string): {type: 'text'; text: string} {
  return {type: 'text', text};
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => 'text' in part ? string(part.text) : '').join('');
}

function savedSteps(message: Message): Step[] | null {
  if (message.role !== 'assistant') return null;
  const raw = (message as Message & {reasoning_content?: unknown}).reasoning_content;
  if (typeof raw !== 'string' || !raw.startsWith(GEMINI_STEPS_PREFIX)) return null;
  try {
    const steps: unknown = JSON.parse(raw.slice(GEMINI_STEPS_PREFIX.length));
    if (Array.isArray(steps) && steps.every((step) => typeof object(step).type === 'string')) {
      return steps as Step[];
    }
  } catch {}
  throw new Error('the saved Gemini conversation steps are invalid');
}

export function interactionRequest(body: Body): Record<string, unknown> {
  const input: Step[] = [];
  let system = '';
  const names = new Map<string, string>();
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      system += (system ? '\n\n' : '') + messageText(message.content);
    } else if (message.role === 'user') {
      input.push({type: 'user_input', content: [textContent(messageText(message.content))]});
    } else if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      if (messageText(message.content).startsWith('Summary of the earlier conversation,')) {
        input.push({type: 'user_input', content: [textContent(messageText(message.content))]});
        continue;
      }
      const steps = savedSteps(message);
      if (steps) {
        input.push(...steps);
      } else {
        const content = messageText(message.content);
        if (content) input.push({type: 'model_output', content: [textContent(content)]});
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments || '{}'),
          });
        }
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_result',
        call_id: message.tool_call_id,
        name: names.get(message.tool_call_id) ?? '',
        result: [textContent(messageText(message.content))],
      });
    }
  }
  const tools = (body.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return {
    model: body.model,
    store: false,
    stream: body.stream === true,
    input,
    ...(system ? {system_instruction: system} : {}),
    ...(tools.length ? {tools} : {}),
    generation_config: {max_output_tokens: body.max_tokens ?? 32_000},
  };
}

function usageOf(raw: unknown): Record<string, number> {
  const usage = object(raw);
  const prompt = Number(usage.total_input_tokens) || 0;
  const completion = Number(usage.total_output_tokens) || 0;
  const cache = Number(usage.total_cached_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    prompt_cache_hit_tokens: cache,
    prompt_cache_miss_tokens: Math.max(0, prompt - cache),
  };
}

function outputText(steps: Step[]): string {
  return steps.flatMap((step) => step.type === 'model_output'
    ? (Array.isArray(step.content) ? step.content : []).map((part) => string(object(part).text))
    : []).join('');
}

function usageChunk(raw: unknown): unknown {
  return {choices: [], usage: usageOf(raw)};
}

function finishChunk(steps: Step[], status: string): unknown {
  const calls = steps.filter((step) => step.type === 'function_call');
  return {
    choices: [{index: 0, delta: {
      reasoning_content: GEMINI_STEPS_PREFIX + JSON.stringify(steps),
      tool_calls: calls.map((step, index) => ({
        index,
        id: string(step.id),
        type: 'function',
        function: {name: string(step.name), arguments: JSON.stringify(step.arguments ?? {})},
      })),
    }, finish_reason: status === 'requires_action' ? 'tool_calls' : 'stop'}],
  };
}

function appendText(step: Step, delta: Record<string, unknown>): void {
  const content = Array.isArray(step.content) ? step.content as Record<string, unknown>[] : [];
  const last = content.at(-1);
  if (last?.type === 'text') last.text = string(last.text) + string(delta.text);
  else content.push(textContent(string(delta.text)));
  step.content = content;
}

export async function* interactionStream(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  const steps = new Map<number, Step>();
  const args = new Map<number, string>();
  let completion: Record<string, unknown> | null = null;
  for await (const raw of source) {
    const event = object(raw) as Event;
    const index = event.index;
    if (event.event_type === 'error') {
      throw new Error(string(object(event.error).message) || 'Gemini stream failed');
    }
    if (event.event_type === 'step.start' && typeof index === 'number') {
      const step = object(event.step) as Step;
      steps.set(index, structuredClone(step));
    } else if (event.event_type === 'step.delta' && typeof index === 'number') {
      const step = steps.get(index);
      if (!step) throw new Error('Gemini sent a delta before its step');
      const delta = object(event.delta);
      if (delta.type === 'text' && step.type === 'model_output') {
        appendText(step, delta);
        if (string(delta.text)) yield {
          choices: [{index: 0, delta: {content: delta.text}, finish_reason: null}],
        };
      } else if (delta.type === 'arguments_delta' && step.type === 'function_call') {
        args.set(index, (args.get(index) ?? '') + string(delta.arguments));
      } else if (delta.type === 'thought_signature' && step.type === 'thought') {
        step.signature = delta.signature;
      } else if (delta.type === 'thought_summary' && step.type === 'thought') {
        const summary = Array.isArray(step.summary) ? step.summary : [];
        summary.push(delta.content);
        step.summary = summary;
      }
    } else if (event.event_type === 'step.stop' && typeof index === 'number') {
      const step = steps.get(index);
      const encoded = args.get(index);
      if (step?.type === 'function_call' && encoded !== undefined) {
        step.arguments = JSON.parse(encoded);
      }
    } else if (event.event_type === 'interaction.completed') {
      completion = object(event.interaction);
    }
  }
  if (!completion) throw new Error('Gemini stream ended without a completion');
  const status = string(completion.status);
  if (status !== 'completed' && status !== 'requires_action') {
    throw new Error(`Gemini stopped with status ${status || 'unknown'}`);
  }
  const finished = Array.isArray(completion.steps)
    ? completion.steps as Step[]
    : [...steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step);
  yield finishChunk(finished, status);
  yield usageChunk(completion.usage);
}

function unaryResponse(raw: unknown): unknown {
  const interaction = object(raw);
  const status = string(interaction.status);
  if (status !== 'completed' && status !== 'requires_action') {
    throw new Error(`Gemini stopped with status ${status || 'unknown'}`);
  }
  const steps = Array.isArray(interaction.steps) ? interaction.steps as Step[] : [];
  return {
    choices: [{index: 0, message: {role: 'assistant', content: outputText(steps)},
      finish_reason: status === 'requires_action' ? 'tool_calls' : 'stop'}],
    usage: usageOf(interaction.usage),
  };
}

export function geminiInvoke(apiKey: string): Invoke {
  const ai = new GoogleGenAI({apiKey});
  return (request, signal) =>
    ai.interactions.create(request as never, {
      signal,
      retries: {strategy: 'none'},
    });
}

export function geminiClient(apiKey: string, invoke?: Invoke): OpenAI {
  const call = invoke ?? geminiInvoke(apiKey);
  const create = async (body: Body, options?: {signal?: AbortSignal}): Promise<unknown> => {
    const response = await call(interactionRequest(body), options?.signal);
    return body.stream
      ? interactionStream(response as AsyncIterable<unknown>)
      : unaryResponse(response);
  };
  return {chat: {completions: {create}}} as unknown as OpenAI;
}
