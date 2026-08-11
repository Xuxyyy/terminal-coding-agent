import type OpenAI from 'openai';
import type {SessionMeta, StoredSession} from '../core/store.js';
import type {Item} from './events.js';

export function restoreItems(
  messages: OpenAI.ChatCompletionMessageParam[],
): Item[] {
  void messages;
  throw new Error('not implemented: restoreItems');
}

export function restoreSummary(meta: SessionMeta, messages: number): string {
  void meta;
  throw new Error(`not implemented: restoreSummary(${messages})`);
}

export function restoreView(session: StoredSession): Item[] {
  void session;
  throw new Error('not implemented: restoreView');
}
