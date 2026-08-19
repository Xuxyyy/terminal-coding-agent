import * as fs from 'node:fs';
import * as path from 'node:path';
import {DEFAULT_MODE, isMode, MODES, type Mode} from './permission/mode.js';
import {accHome, makeDir} from './projects.js';

export type Rules = {allow: string[]; ask: string[]; deny: string[]};

const LISTS: (keyof Rules)[] = ['allow', 'ask', 'deny'];
const RULE_PATTERN = /^bash\((.*)\)$/;
const MODE_KEY = 'permission_mode';

export class SettingsError extends Error {}

function emptyRules(): Rules {
  return {allow: [], ask: [], deny: []};
}

export function userSettingsFile(): string {
  return path.join(accHome(), 'settings.json');
}

export function settingsFiles(root: string): string[] {
  return [userSettingsFile(), path.join(root, '.acc', 'settings.json')];
}

function isUserSettings(file: string): boolean {
  return path.resolve(file) === path.resolve(userSettingsFile());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string, file: string): Record<string, unknown> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(root)) {
    throw new SettingsError(`${file} must hold a JSON object`);
  }
  return root;
}

export function parseMode(text: string, file: string, user: boolean): Mode | null {
  const value = parseObject(text, file)[MODE_KEY];
  if (value === undefined) return null;
  if (!user) {
    throw new SettingsError(
      `${file}: "${MODE_KEY}" is only read from ${userSettingsFile()}; ` +
        'remove it from this file',
    );
  }
  if (!isMode(value)) {
    throw new SettingsError(
      `${file}: "${MODE_KEY}" is ${JSON.stringify(value)}; use ${MODES.join(', ')}`,
    );
  }
  return value;
}

export function parseSettings(text: string, file: string): Rules {
  const root = parseObject(text, file);
  const rules = emptyRules();
  const permissions = root.permissions;
  if (permissions === undefined) return rules;
  if (!isObject(permissions)) {
    throw new SettingsError(`${file}: "permissions" must be an object`);
  }
  for (const key of Object.keys(permissions)) {
    if (!LISTS.includes(key as keyof Rules)) {
      throw new SettingsError(
        `${file}: "permissions" has no key "${key}"; use allow, ask, or deny`,
      );
    }
  }
  for (const list of LISTS) {
    const value = permissions[list];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new SettingsError(`${file}: "permissions.${list}" must be an array`);
    }
    for (const rule of value) {
      if (typeof rule !== 'string') {
        throw new SettingsError(
          `${file}: every rule in "permissions.${list}" must be a string, found ` +
            `${JSON.stringify(rule)}`,
        );
      }
      const match = RULE_PATTERN.exec(rule);
      if (!match) {
        throw new SettingsError(
          `${file}: the rule ${JSON.stringify(rule)} in "permissions.${list}" must ` +
            'be written bash(<pattern>); bash is the only supported tag',
        );
      }
      rules[list].push(match[1]);
    }
  }
  return rules;
}

let cached: Rules = emptyRules();
let cachedMode: Mode = DEFAULT_MODE;

export function loadSettings(
  files: string[] = settingsFiles(process.cwd()),
): Rules {
  const merged = emptyRules();
  let mode: Mode = DEFAULT_MODE;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new SettingsError(`${file} could not be read: ${(error as Error).message}`);
    }
    const rules = parseSettings(text, file);
    for (const list of LISTS) merged[list].push(...rules[list]);
    mode = parseMode(text, file, isUserSettings(file)) ?? mode;
  }
  cached = merged;
  cachedMode = mode;
  return merged;
}

export function rulesOf(): Rules {
  return cached;
}

export function modeOf(): Mode {
  return cachedMode;
}

export function rememberMode(mode: Mode): void {
  const file = userSettingsFile();
  const existing = fs.existsSync(file)
    ? parseObject(fs.readFileSync(file, 'utf8'), file)
    : {};
  makeDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify({...existing, [MODE_KEY]: mode}, null, 2)}\n`, {
    mode: 0o600,
  });
  cachedMode = mode;
}
