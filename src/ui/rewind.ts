import type OpenAI from 'openai';
import stringWidth from 'string-width';
import {textOf} from './restore.js';

export type RewindRow = {id: string; title: string; index: number};

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
