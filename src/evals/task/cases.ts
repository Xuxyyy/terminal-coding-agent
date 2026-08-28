import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import type {HeadlessPolicy} from '../../core/headless/host.js';
import {isMode, MODES, type Mode} from '../../core/permission/mode.js';

export const CATEGORIES = [
  'edit',
  'find',
  'create',
  'restraint',
  'guard',
  'recover',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const POLICIES: HeadlessPolicy[] = ['deny', 'yes'];

export const CHECK_KINDS = [
  'exit0',
  'exists',
  'absent',
  'contains',
  'matches',
  'unchanged',
  'answers',
  'prompted',
] as const;

export type Check =
  | {kind: 'exit0'; command: string}
  | {kind: 'exists'; path: string}
  | {kind: 'absent'; path: string}
  | {kind: 'contains'; path: string; text: string}
  | {kind: 'matches'; path: string; pattern: string}
  | {kind: 'unchanged'; path: string}
  | {kind: 'answers'; pattern: string}
  | {kind: 'prompted'};

export type TaskCase = {
  id: string;
  category: Category;
  task: {
    prompt: string;
    mode: Mode;
    policy: HeadlessPolicy;
    maxSeconds: number;
  };
  grade: {
    allowedWrites: string[];
    checks: Check[];
    expectedAnswer?: string;
  };
  dir: string;
};

export class CaseError extends Error {
  constructor(where: string, detail: string) {
    super(`${where}: ${detail}`);
    this.name = 'CaseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(where: string, value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CaseError(where, `${key} must be an object`);
  return value;
}

function stringField(
  where: string,
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CaseError(where, `${key} must be a non-empty string`);
  }
  return value;
}

function noClimbing(where: string, key: string, value: string): string {
  if (value.split('/').includes('..')) {
    throw new CaseError(where, `${key} '${value}' must not climb out with '..'`);
  }
  return value;
}

function relativePath(where: string, key: string, value: string): string {
  if (isAbsolute(value)) {
    throw new CaseError(where, `${key} '${value}' must be workspace-relative`);
  }
  return noClimbing(where, key, value);
}

function parseCheck(where: string, raw: unknown, index: number): Check {
  const at = `${where}: grade.checks[${index}]`;
  const source = object(at, raw, 'a check');
  const kind = source['kind'];
  const kinds: readonly string[] = CHECK_KINDS;
  if (typeof kind !== 'string' || !kinds.includes(kind)) {
    throw new CaseError(at, `kind must be one of ${CHECK_KINDS.join(', ')}`);
  }
  if (kind === 'exit0') {
    return {kind, command: stringField(at, source, 'command')};
  }
  if (kind === 'answers') {
    const pattern = stringField(at, source, 'pattern');
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new CaseError(at, `pattern is not a regex — ${(error as Error).message}`);
    }
    return {kind, pattern};
  }
  if (kind === 'prompted') {
    return {kind};
  }
  const path = noClimbing(at, 'path', stringField(at, source, 'path'));
  if (kind === 'contains') {
    return {kind, path, text: stringField(at, source, 'text')};
  }
  if (kind === 'matches') {
    const pattern = stringField(at, source, 'pattern');
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new CaseError(at, `pattern is not a regex — ${(error as Error).message}`);
    }
    return {kind, path, pattern};
  }
  return {kind: kind as 'exists' | 'absent' | 'unchanged', path};
}

function parseTask(where: string, raw: unknown): TaskCase['task'] {
  const source = object(where, raw, 'task');
  const mode = source['mode'];
  if (!isMode(mode)) {
    throw new CaseError(
      where,
      `task.mode is ${JSON.stringify(mode)}; use ${MODES.join(', ')}`,
    );
  }
  const policy = source['policy'];
  if (typeof policy !== 'string' || !(POLICIES as string[]).includes(policy)) {
    throw new CaseError(
      where,
      `task.policy is ${JSON.stringify(policy)}; use ${POLICIES.join(', ')}`,
    );
  }
  const maxSeconds = source['maxSeconds'];
  if (typeof maxSeconds !== 'number' || !Number.isInteger(maxSeconds) || maxSeconds < 1) {
    throw new CaseError(
      where,
      `task.maxSeconds is ${JSON.stringify(maxSeconds)}; use a positive whole number`,
    );
  }
  return {
    prompt: stringField(where, source, 'prompt'),
    mode,
    policy: policy as HeadlessPolicy,
    maxSeconds,
  };
}

function parseGrade(where: string, raw: unknown): TaskCase['grade'] {
  const source = object(where, raw, 'grade');
  const writes = source['allowedWrites'];
  if (!Array.isArray(writes) || writes.some((item) => typeof item !== 'string')) {
    throw new CaseError(where, 'grade.allowedWrites must be an array of strings');
  }
  const allowedWrites = (writes as string[]).map((value) =>
    relativePath(where, 'grade.allowedWrites', value),
  );
  const checks = source['checks'];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new CaseError(where, 'grade.checks must be a non-empty array');
  }
  const grade: TaskCase['grade'] = {
    allowedWrites,
    checks: checks.map((raw, index) => parseCheck(where, raw, index)),
  };
  const expected = source['expectedAnswer'];
  if (expected !== undefined) {
    if (typeof expected !== 'string' || expected.length === 0) {
      throw new CaseError(where, 'grade.expectedAnswer must be a non-empty string');
    }
    grade.expectedAnswer = expected;
  }
  return grade;
}

export function parseCase(where: string, raw: unknown, dir: string): TaskCase {
  const source = object(where, raw, 'a case');
  const id = stringField(where, source, 'id');
  const category = source['category'];
  if (
    typeof category !== 'string' ||
    !(CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new CaseError(where, `category must be one of ${CATEGORIES.join(', ')}`);
  }
  return {
    id,
    category: category as Category,
    task: parseTask(where, source['task']),
    grade: parseGrade(where, source['grade']),
    dir,
  };
}

export function loadCase(dir: string): TaskCase {
  const full = resolve(dir);
  const file = join(full, 'case.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new CaseError(full, 'has no case.json');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CaseError(full, `case.json is not valid JSON — ${(error as Error).message}`);
  }
  const workspace = join(full, 'workspace');
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new CaseError(full, 'has no workspace/ directory');
  }
  return parseCase(full, raw, full);
}

export function loadCases(root: string): TaskCase[] {
  const full = resolve(root);
  let names: string[];
  try {
    names = readdirSync(full, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new CaseError(full, 'is not a directory of cases');
  }
  const cases: TaskCase[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const parsed = loadCase(join(full, name));
    const first = seen.get(parsed.id);
    if (first !== undefined) {
      throw new CaseError(
        join(full, name),
        `duplicate id '${parsed.id}', first used by ${first}`,
      );
    }
    seen.set(parsed.id, name);
    cases.push(parsed);
  }
  return cases;
}
