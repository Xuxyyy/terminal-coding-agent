import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Usage} from './host.js';

type Message = OpenAI.ChatCompletionMessageParam;

export type SessionRecord =
  | {kind: 'view'; items: unknown[]}
  | {kind: 'message'; id: string; message: Message}
  | {kind: 'messages'; messages: Message[]; usage: Usage};

const RECORDS = 'session.jsonl';

function recordsFile(dir: string): string {
  return path.join(dir, RECORDS);
}

export function appendRecord(dir: string, record: SessionRecord): void {
  fs.appendFileSync(recordsFile(dir), `${JSON.stringify(record)}\n`, {mode: 0o600});
}

export function readRecords(dir: string): SessionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(recordsFile(dir), 'utf8');
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {}
  }
  return records;
}

export function messagesOf(records: SessionRecord[]): Message[] {
  return records.flatMap((record) =>
    record.kind === 'message'
      ? [record.message]
      : record.kind === 'messages'
        ? record.messages
        : [],
  );
}

export function viewOf(records: SessionRecord[]): unknown[] {
  return records.flatMap((record) => (record.kind === 'view' ? record.items : []));
}
