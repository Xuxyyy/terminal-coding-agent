import type OpenAI from 'openai';
import stringWidth from 'string-width';
import {SUMMARY_PREFIX} from '../core/compact.js';
import {textOf} from './restore.js';

export type RewindRow = {id: string; title: string; index: number};

export const NOTHING_TO_REWIND = 'Nothing to rewind yet.';

export const REWIND_STOPS_AT_COMPACT =
  'The history was compacted; only messages after it can be rewound.';

export function rewindEmpty(
  messages: OpenAI.ChatCompletionMessageParam[],
): string {
  const compacted = messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.startsWith(SUMMARY_PREFIX),
  );
  return compacted ? REWIND_STOPS_AT_COMPACT : NOTHING_TO_REWIND;
}

export function rewindRows(
  messages: OpenAI.ChatCompletionMessageParam[],
): RewindRow[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user') return [];
    const title = textOf(message.content).replace(/\s+/g, ' ').trim();
    return [{id: String(index), index, title: title || '(empty message)'}];
  });
}

export function rewindLine(row: RewindRow, active: boolean, width: number): string {
  const marker = active ? '❯ ' : '  ';
  const room = Math.max(8, width - stringWidth(marker));
  let title = row.title;
  if (stringWidth(title) > room) {
    while (stringWidth(title) > room - 1) title = title.slice(0, -1);
    title += '…';
  }
  return `${marker}${title}`;
}
