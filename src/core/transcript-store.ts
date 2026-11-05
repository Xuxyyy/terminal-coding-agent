import * as crypto from 'node:crypto';
import type OpenAI from 'openai';
import type {Usage} from './host.js';
import {assistantContinuation} from './messages.js';
import {appendRecord, liveRecords, readRecords} from './records.js';
import type {SessionStore} from './store.js';

type Message = OpenAI.ChatCompletionMessageParam;

export function transcriptStore(
  dir: string,
  id: string,
  onWrite: (messages?: Message[], usage?: Usage) => void,
  onClose: () => void,
  name = 'session.jsonl',
): SessionStore {
  const written = new Set<Message>();
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error('session store is closed');
  };

  const write = (record: Parameters<typeof appendRecord>[1]): void => {
    appendRecord(dir, {...record, ...(store.trace ? {trace: store.trace.reference()} : {})}, name);
  };
  const store: SessionStore = {
    id,
    dir,
    seed(messages) {
      ensureOpen();
      for (const message of messages) written.add(message);
    },
    appendMessage(message) {
      ensureOpen();
      const id = crypto.randomBytes(4).toString('hex');
      write({kind: 'message', id, message});
      written.add(message);
      onWrite([message]);
      return id;
    },
    appendStep(messages, usage) {
      ensureOpen();
      const fresh = messages.filter(
        (message, index) => !(index === 0 && message.role === 'system') && !written.has(message),
      );
      if (fresh.length === 0) return;
      write({kind: 'messages', messages: fresh, usage});
      for (const message of fresh) written.add(message);
      onWrite(fresh, usage);
    },
    appendCompact(summary, replaced, replacement) {
      ensureOpen();
      const continuation = assistantContinuation(summary);
      write({
        kind: 'compact',
        summary: typeof summary.content === 'string' ? summary.content : '',
        replaced,
        ...(continuation ? {continuation} : {}),
        replacement,
      });
      for (const message of replacement) written.add(message);
      onWrite();
    },
    appendView(items) {
      ensureOpen();
      if (items.length === 0) return;
      write({kind: 'view', items});
      onWrite();
    },
    appendCode(path, before) {
      ensureOpen();
      write({kind: 'code', path, before});
      onWrite();
    },
    records() {
      return liveRecords(readRecords(dir, name));
    },
    rewind(to) {
      ensureOpen();
      write({kind: 'rewind', to});
      onWrite();
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
    },
  };
  return store;
}
