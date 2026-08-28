import type OpenAI from 'openai';
import type {Request} from '../../core/permission/decide.js';
import type {JudgeInput} from '../../core/permission/judge.js';

export const CATEGORIES = [
  'direct',
  'broad',
  'stale',
  'override',
  'unasked',
  'destructive',
  'outward',
  'secrets',
  'outside',
  'injection',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const LABELS = ['allow', 'refuse'] as const;

export type Label = (typeof LABELS)[number];

export const REQUEST_KINDS = ['command', 'write', 'read', 'mcp'] as const;

export type EvalCall = [name: string, args: Record<string, unknown>];

export type EvalCase = {
  id: string;
  category: Category;
  label: Label;
  asked: string[];
  calls: EvalCall[];
  root: string;
  request: Request;
  reason: string;
  denied?: string[];
  command?: string;
  note: string;
};

export function toJudgeInput(c: EvalCase): JudgeInput {
  const messages: OpenAI.ChatCompletionMessageParam[] = c.calls.map(
    ([name, args], index) => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `${c.id}-${index}`,
          type: 'function',
          function: {name, arguments: JSON.stringify(args)},
        },
      ],
    }),
  );
  return {
    asked: c.asked,
    messages,
    root: c.root,
    request: c.request,
    reason: c.reason,
    ...(c.denied === undefined ? {} : {denied: c.denied}),
    ...(c.command === undefined ? {} : {command: c.command}),
  };
}

class CaseError extends Error {
  constructor(line: number, detail: string) {
    super(`line ${line}: ${detail}`);
    this.name = 'CaseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  line: number,
  source: Record<string, unknown>,
  key: string,
  where = '',
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CaseError(line, `${where}${key} must be a non-empty string`);
  }
  return value;
}

function stringList(
  line: number,
  source: Record<string, unknown>,
  key: string,
): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CaseError(line, `${key} must be an array of strings`);
  }
  return value as string[];
}

function parseCalls(line: number, value: unknown): EvalCall[] {
  if (!Array.isArray(value)) {
    throw new CaseError(line, 'calls must be an array');
  }
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new CaseError(line, 'each call must be [name, args]');
    }
    const [name, args] = entry as [unknown, unknown];
    if (typeof name !== 'string' || name.length === 0) {
      throw new CaseError(line, 'a call name must be a non-empty string');
    }
    if (!isRecord(args)) {
      throw new CaseError(line, `call ${name} must carry an args object`);
    }
    return [name, args] as EvalCall;
  });
}

function parseRequest(line: number, value: unknown): Request {
  if (!isRecord(value)) throw new CaseError(line, 'request must be an object');
  const kind = value['kind'];
  const kinds: readonly string[] = REQUEST_KINDS;
  if (typeof kind !== 'string' || !kinds.includes(kind)) {
    throw new CaseError(
      line,
      `request.kind must be one of ${REQUEST_KINDS.join(', ')}`,
    );
  }
  if (kind === 'command') {
    const request: Request = {
      kind: 'command',
      command: stringField(line, value, 'command', 'request.'),
    };
    const reason = value['reason'];
    if (reason !== undefined) {
      if (typeof reason !== 'string') {
        throw new CaseError(line, 'request.reason must be a string');
      }
      request.reason = reason;
    }
    return request;
  }
  if (kind === 'mcp') {
    return {
      kind: 'mcp',
      server: stringField(line, value, 'server', 'request.'),
      tool: stringField(line, value, 'tool', 'request.'),
    };
  }
  return {
    kind: kind as 'write' | 'read',
    path: stringField(line, value, 'path', 'request.'),
  };
}

function parseCase(line: number, raw: unknown): EvalCase {
  if (!isRecord(raw)) throw new CaseError(line, 'a case must be an object');

  const id = stringField(line, raw, 'id');
  const category = raw['category'];
  if (
    typeof category !== 'string' ||
    !CATEGORIES.includes(category as Category)
  ) {
    throw new CaseError(
      line,
      `category must be one of ${CATEGORIES.join(', ')}`,
    );
  }
  const label = raw['label'];
  if (typeof label !== 'string' || !LABELS.includes(label as Label)) {
    throw new CaseError(line, `label must be one of ${LABELS.join(', ')}`);
  }
  if (typeof raw['note'] !== 'string') {
    throw new CaseError(line, 'note must be a string');
  }

  const built: EvalCase = {
    id,
    category: category as Category,
    label: label as Label,
    asked: stringList(line, raw, 'asked'),
    calls: parseCalls(line, raw['calls']),
    root: stringField(line, raw, 'root'),
    request: parseRequest(line, raw['request']),
    reason: stringField(line, raw, 'reason'),
    note: raw['note'],
  };
  if (raw['denied'] !== undefined) {
    built.denied = stringList(line, raw, 'denied');
  }
  if (raw['command'] !== undefined) {
    built.command = stringField(line, raw, 'command');
  }
  return built;
}

export function parseCases(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Map<string, number>();
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const source = lines[index]!.trim();
    if (source.length === 0) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new CaseError(line, `not valid JSON — ${(error as Error).message}`);
    }

    const parsed = parseCase(line, raw);
    const first = seen.get(parsed.id);
    if (first !== undefined) {
      throw new CaseError(line, `duplicate id '${parsed.id}', first at line ${first}`);
    }
    seen.set(parsed.id, line);
    cases.push(parsed);
  }

  return cases;
}
