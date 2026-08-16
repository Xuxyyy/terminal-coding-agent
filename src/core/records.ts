import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Usage} from './host.js';

type Message = OpenAI.ChatCompletionMessageParam;

export type SessionRecord =
  | {kind: 'view'; items: unknown[]}
  | {kind: 'message'; id: string; message: Message}
  | {kind: 'messages'; messages: Message[]; usage: Usage}
  | {kind: 'compact'; summary: string; replaced: number}
  | {kind: 'code'; path: string; before: string | null}
  | {kind: 'rewind'; to: number};

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

export function liveRecords(records: SessionRecord[]): SessionRecord[] {
  const live: SessionRecord[] = [];
  for (const record of records) {
    if (record.kind === 'rewind') {
      live.length = Math.min(live.length, Math.max(0, record.to));
    } else {
      live.push(record);
    }
  }
  return live;
}

export function messagesOf(records: SessionRecord[]): Message[] {
  let messages: Message[] = [];
  for (const record of records) {
    if (record.kind === 'compact') {
      messages = [{role: 'assistant', content: record.summary}];
    } else if (record.kind === 'message') {
      messages.push(record.message);
    } else if (record.kind === 'messages') {
      messages.push(...record.messages);
    }
  }
  return messages;
}

export function lastUsageOf(records: SessionRecord[]): Usage | null {
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at];
    if (record && record.kind === 'compact') return null;
    if (record && record.kind === 'messages') return record.usage;
  }
  return null;
}

export type Checkpoint = {id: string; at: number};

export function checkpointsOf(records: SessionRecord[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  records.forEach((record, at) => {
    if (record.kind === 'message') checkpoints.push({id: record.id, at});
  });
  return checkpoints;
}

export function viewOf(records: SessionRecord[]): unknown[] {
  return records.flatMap((record) => (record.kind === 'view' ? record.items : []));
}
