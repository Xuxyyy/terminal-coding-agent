import type OpenAI from 'openai';
import type {SessionMeta, StoredSession} from '../core/store.js';
import type {Item} from './events.js';

type Message = OpenAI.ChatCompletionMessageParam;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as {text: unknown}).text)
        : '',
    )
    .join('');
}

function argsOf(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return raw;
  }
}

export function restoreItems(messages: Message[]): Item[] {
  const items: Item[] = [];
  const names = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'user') {
      items.push({kind: 'task', text: textOf(message.content)});
    } else if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text) items.push({kind: 'text', text});
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name);
        items.push({
          kind: 'event',
          event: {
            type: 'tool_start',
            id: call.id,
            name: call.function.name,
            args: argsOf(call.function.arguments),
          },
        });
      }
    } else if (message.role === 'tool') {
      items.push({
        kind: 'event',
        event: {
          type: 'tool_end',
          id: message.tool_call_id,
          name: names.get(message.tool_call_id) ?? '',
          result: textOf(message.content),
          diff: null,
        },
      });
    }
  }
  return items;
}

export function restoreSummary(meta: SessionMeta, messages: number): string {
  return `restored ${messages} messages from ${meta.startedAt.replace('T', ' ').slice(0, 16)}`;
}

export function restoreView(session: StoredSession): Item[] {
  const {meta, messages} = session;
  const notice: Item = {
    kind: 'notice',
    text: restoreSummary(meta, messages.length),
  };
  let last = -1;
  for (let n = messages.length - 1; n >= 0 && last < 0; n -= 1) {
    if (messages[n]!.role === 'user') last = n;
  }
  return last < 0 ? [notice] : [notice, ...restoreItems(messages.slice(last))];
}
