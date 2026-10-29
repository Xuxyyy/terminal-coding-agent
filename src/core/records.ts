import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import type {Usage} from './host.js';
import {
  assistantMessage,
  type AssistantContinuation,
} from './messages.js';

type Message = OpenAI.ChatCompletionMessageParam;

export type SessionRecord =
  | {kind: 'view'; items: unknown[]}
  | {kind: 'message'; id: string; message: Message}
  | {kind: 'messages'; messages: Message[]; usage: Usage}
  | {
      kind: 'compact';
      summary: string;
      replaced: number;
      continuation?: AssistantContinuation;
      replacement?: Message[];
    }
  | {kind: 'code'; path: string; before: string | null}
  | {kind: 'rewind'; to: number};

const RECORDS = 'session.jsonl';

function recordsFile(dir: string, name: string): string {
  return path.join(dir, name);
}

export function appendRecord(dir: string, record: SessionRecord, name = RECORDS): void {
  fs.appendFileSync(recordsFile(dir, name), `${JSON.stringify(record)}\n`, {mode: 0o600});
}

export function readRecords(dir: string, name = RECORDS, required = false): SessionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(recordsFile(dir, name), 'utf8');
  } catch (error) {
    if (required) throw error;
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
      messages = record.replacement
        ? [...record.replacement]
        : [assistantMessage(record.summary, [], record.continuation)];
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

export function recoverToolResults(messages: Message[]): {messages: Message[]; recovered: Message[]} {
  const ordered: Message[] = [];
  const recovered: Message[] = [];
  const moved = new Set<Message>();
  for (let at = 0; at < messages.length; at++) {
    const message = messages[at];
    if (moved.has(message)) continue;
    ordered.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    let end = at + 1;
    while (end < messages.length && messages[end].role !== 'assistant') end++;
    const following = messages.slice(at + 1, end);
    for (const call of message.tool_calls) {
      const saved = following.find((candidate) => candidate.role === 'tool' && candidate.tool_call_id === call.id && !moved.has(candidate));
      if (saved) { ordered.push(saved); moved.add(saved); continue; }
      const result: Message = {
        role: 'tool', tool_call_id: call.id,
        content: `[runtime: ${call.function.name} was interrupted before its result was saved. Execution is uncertain; effects may have occurred. Inspect current state before repeating this action. For agent calls, list existing children before creating or resuming work. No old tool call was replayed.]`,
      };
      ordered.push(result);
      recovered.push(result);
    }
  }
  return {messages: ordered, recovered};
}
