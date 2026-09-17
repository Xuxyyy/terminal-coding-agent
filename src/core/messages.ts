import type OpenAI from 'openai';

export type AssistantContinuation = {
  kind: 'reasoning_content';
  content: string;
};

type AssistantMessage = OpenAI.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

type Call = {id: string; name: string; args: string};

export function assistantMessage(
  content: string,
  calls: Call[],
  continuation?: AssistantContinuation,
): OpenAI.ChatCompletionMessageParam {
  const message: AssistantMessage =
    calls.length === 0
      ? {role: 'assistant', content}
      : {
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {name: call.name, arguments: call.args},
          })),
        };
  if (continuation?.kind === 'reasoning_content') {
    message.reasoning_content = continuation.content;
  }
  return message;
}

export function assistantContinuation(
  message: OpenAI.ChatCompletionMessageParam,
): AssistantContinuation | undefined {
  if (message.role !== 'assistant') return undefined;
  const content = (message as AssistantMessage).reasoning_content;
  if (typeof content !== 'string') return undefined;
  return {kind: 'reasoning_content', content};
}
