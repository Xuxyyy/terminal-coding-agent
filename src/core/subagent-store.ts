import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ModelSettings} from './client.js';
import {makeDir, writeJson} from './projects.js';
import {lastUsageOf, messagesOf, liveRecords, readRecords} from './records.js';
import type {SessionStore} from './store.js';
import {transcriptStore} from './transcript-store.js';

const rule = z.object({tag: z.enum(['bash', 'edit']), pattern: z.string()});
const usage = z.object({prompt: z.number(), completion: z.number(), total: z.number()});
const metadata = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  parentId: z.string(),
  workspace: z.string(),
  description: z.string(),
  agent: z.string().optional(),
  role: z.string().optional(),
  tools: z.array(z.string()),
  mode: z.enum(['ask-edits', 'auto-edits', 'auto']),
  sandbox: z.enum(['on', 'off']),
  rules: z.object({allow: z.array(rule), ask: z.array(rule), deny: z.array(rule)}),
  modelSettings: z.object({
    provider: z.string(), baseURL: z.string(), model: z.string(),
    reasoningEffort: z.enum(['none', 'low', 'high', 'max']),
    thinking: z.enum(['enabled', 'disabled']), maxOutputTokens: z.number(),
    requestTimeoutMs: z.number(), startupTimeoutMs: z.number(), idleTimeoutMs: z.number(),
  }),
  startedAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['running', 'completed', 'interrupted', 'failed']),
  usage,
  assignmentId: z.string().optional(),
  background: z.boolean().optional(),
  result: z.object({text: z.string(), failure: z.boolean().optional(), usage: usage.optional()}).optional(),
});

export type SubagentMeta = z.infer<typeof metadata>;
export type SubagentConfig = Pick<SubagentMeta,
  'workspace' | 'description' | 'agent' | 'role' | 'tools' | 'mode' | 'sandbox' | 'rules'> & {
    modelSettings: ModelSettings;
  };

const active = new Set<string>();

function files(parent: SessionStore, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error('invalid subagent ID');
  const dir = path.join(parent.dir, 'subagents');
  return {dir, meta: path.join(dir, `agent-${id}.json`), log: `agent-${id}.jsonl`};
}

function readMeta(parent: SessionStore, id: string): SubagentMeta {
  const file = files(parent, id);
  let meta: SubagentMeta;
  try {
    meta = metadata.parse(JSON.parse(fs.readFileSync(file.meta, 'utf8')));
  } catch {
    throw new Error(`no readable subagent '${id}' in this parent session`);
  }
  if (meta.id !== id || meta.parentId !== parent.id) throw new Error('subagent belongs to another parent session');
  return meta;
}

export function loadSubagent(parent: SessionStore, id: string) {
  const file = files(parent, id);
  const meta = readMeta(parent, id);
  let saved;
  try {
    saved = readRecords(file.dir, file.log, true);
  } catch {
    throw new Error(`subagent '${id}' transcript is missing or unreadable`);
  }
  const records = liveRecords(saved);
  meta.usage = saved.reduce((total, record) => {
    if (record.kind === 'messages') {
      total.prompt += record.usage.prompt;
      total.completion += record.usage.completion;
      total.total += record.usage.total;
    }
    return total;
  }, {prompt: 0, completion: 0, total: 0});
  return {meta, messages: messagesOf(records), lastUsage: lastUsageOf(records)};
}

export function listSubagents(parent: SessionStore): SubagentMeta[] {
  const dir = path.join(parent.dir, 'subagents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^agent-[\da-f-]+\.json$/.test(name)).map((name) => {
    const id = name.slice(6, -5);
    const meta = readMeta(parent, id);
    return meta.status === 'running' && !active.has(files(parent, id).meta)
      ? {...meta, status: 'interrupted' as const} : meta;
  }).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

export function startSubagent(parent: SessionStore, config: SubagentConfig) {
  const now = new Date().toISOString();
  const meta: SubagentMeta = {
    ...config, version: 1, id: randomUUID(), parentId: parent.id,
    startedAt: now, updatedAt: now, status: 'running',
    usage: {prompt: 0, completion: 0, total: 0},
  };
  const file = files(parent, meta.id);
  makeDir(file.dir);
  fs.writeFileSync(path.join(file.dir, file.log), '', {flag: 'wx', mode: 0o600});
  return openSubagent(parent, meta);
}

export function openSubagent(parent: SessionStore, meta: SubagentMeta) {
  const file = files(parent, meta.id);
  if (meta.parentId !== parent.id) throw new Error('subagent belongs to another parent session');
  if (active.has(file.meta)) throw new Error('subagent is already running');
  const log = path.join(file.dir, file.log);
  const text = fs.readFileSync(log, 'utf8');
  if (text && !text.endsWith('\n')) fs.appendFileSync(log, '\n');
  const write = (): void => {
    meta.updatedAt = new Date().toISOString();
    const temporary = `${file.meta}.tmp`;
    writeJson(temporary, meta);
    fs.renameSync(temporary, file.meta);
  };
  meta.status = 'running';
  meta.assignmentId = randomUUID();
  meta.result = undefined;
  write();
  active.add(file.meta);
  const store = transcriptStore(file.dir, meta.id, (_messages, usage) => {
    if (usage) {
      meta.usage.prompt += usage.prompt;
      meta.usage.completion += usage.completion;
      meta.usage.total += usage.total;
    }
    write();
  }, () => {
    try {
      if (meta.status === 'running') meta.status = 'interrupted';
      write();
    } finally {
      active.delete(file.meta);
    }
  }, file.log);
  return {meta, store, finish(status: Exclude<SubagentMeta['status'], 'running'>, result?: SubagentMeta['result']) {
    meta.status = status;
    meta.result = result;
    store.close();
  }};
}
