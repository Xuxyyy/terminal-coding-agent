import * as fs from 'node:fs';
import * as path from 'node:path';
import {MODEL_IDS, MODELS} from './models.js';
import {DEFAULT_MODE, isMode, MODES, type Mode} from './permission/mode.js';
import {accHome, makeDir} from './projects.js';

export type Tag = 'bash' | 'edit';

export type Rule = {tag: Tag; pattern: string};

export type Rules = {allow: Rule[]; ask: Rule[]; deny: Rule[]};

export type StdioServer = {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
};

const LISTS: (keyof Rules)[] = ['allow', 'ask', 'deny'];
const RULE_PATTERN = /^(bash|edit)\((.*)\)$/;
const WRITE_PATTERN = /^write\(/;
const MODE_KEY = 'permission_mode';
const MODEL_KEY = 'model';
const SERVERS_KEY = 'mcpServers';
const SERVER_KEYS = ['command', 'args', 'env', 'enabled'];
const SERVER_NAME = /^[a-z0-9_-]+$/i;
const VARIABLE = /\$\{([^}]*)\}/g;

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

export function parseModel(
  text: string,
  file: string,
  user: boolean,
): string | null {
  const value = parseObject(text, file)[MODEL_KEY];
  if (value === undefined) return null;
  if (!user) {
    throw new SettingsError(
      `${file}: "${MODEL_KEY}" is only read from ${userSettingsFile()}; ` +
        'remove it from this file',
    );
  }
  if (typeof value !== 'string' || !MODELS[value]) {
    throw new SettingsError(
      `${file}: "${MODEL_KEY}" is ${JSON.stringify(value)}; use ${MODEL_IDS.join(', ')}`,
    );
  }
  return value;
}

function expand(
  value: string,
  where: string,
  file: string,
  environment: NodeJS.ProcessEnv,
): string {
  return value.replace(VARIABLE, (_whole, name: string) => {
    const found = environment[name];
    if (found === undefined) {
      throw new SettingsError(
        `${file}: ${where} uses \${${name}} but ${name} is not set in the environment`,
      );
    }
    return found;
  });
}

function parseServer(
  spec: unknown,
  name: string,
  file: string,
  environment: NodeJS.ProcessEnv,
): StdioServer {
  const where = `"${SERVERS_KEY}.${name}"`;
  if (!isObject(spec)) {
    throw new SettingsError(`${file}: ${where} must be an object`);
  }
  for (const key of Object.keys(spec)) {
    if (!SERVER_KEYS.includes(key)) {
      throw new SettingsError(
        `${file}: ${where} has no key "${key}"; use ${SERVER_KEYS.join(', ')}`,
      );
    }
  }
  if (typeof spec.command !== 'string' || spec.command.trim() === '') {
    throw new SettingsError(
      `${file}: ${where}.command must be a non-empty string`,
    );
  }
  const args: string[] = [];
  if (spec.args !== undefined) {
    if (!Array.isArray(spec.args)) {
      throw new SettingsError(`${file}: ${where}.args must be an array`);
    }
    for (const value of spec.args) {
      if (typeof value !== 'string') {
        throw new SettingsError(
          `${file}: every entry in ${where}.args must be a string, found ` +
            `${JSON.stringify(value)}`,
        );
      }
      args.push(expand(value, `${where}.args`, file, environment));
    }
  }
  const env: Record<string, string> = {};
  if (spec.env !== undefined) {
    if (!isObject(spec.env)) {
      throw new SettingsError(`${file}: ${where}.env must be an object`);
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (typeof value !== 'string') {
        throw new SettingsError(
          `${file}: ${where}.env.${key} must be a string, found ` +
            `${JSON.stringify(value)}`,
        );
      }
      env[key] = expand(value, `${where}.env.${key}`, file, environment);
    }
  }
  let enabled = true;
  if (spec.enabled !== undefined) {
    if (typeof spec.enabled !== 'boolean') {
      throw new SettingsError(`${file}: ${where}.enabled must be true or false`);
    }
    enabled = spec.enabled;
  }
  return {command: spec.command, args, env, enabled};
}

export function parseServers(
  text: string,
  file: string,
  user: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, StdioServer> {
  const value = parseObject(text, file)[SERVERS_KEY];
  if (value === undefined) return {};
  if (!user) {
    throw new SettingsError(
      `${file}: "${SERVERS_KEY}" is only read from ${userSettingsFile()}; ` +
        'remove it from this file',
    );
  }
  if (!isObject(value)) {
    throw new SettingsError(`${file}: "${SERVERS_KEY}" must be an object`);
  }
  const servers: Record<string, StdioServer> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!SERVER_NAME.test(name)) {
      throw new SettingsError(
        `${file}: the server name ${JSON.stringify(name)} in "${SERVERS_KEY}" must ` +
          'use letters, digits, dashes and underscores only',
      );
    }
    servers[name] = parseServer(spec, name, file, environment);
  }
  return servers;
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
        const covered = WRITE_PATTERN.test(rule)
          ? '; edit(<pattern>) covers both edit_file and write_file'
          : '';
        throw new SettingsError(
          `${file}: the rule ${JSON.stringify(rule)} in "permissions.${list}" must ` +
            `be written bash(<pattern>) or edit(<pattern>)${covered}`,
        );
      }
      rules[list].push({tag: match[1] as Tag, pattern: match[2]});
    }
  }
  return rules;
}

let cached: Rules = emptyRules();
let cachedMode: Mode = DEFAULT_MODE;
let cachedModel: string | null = null;
let cachedServers: Record<string, StdioServer> = {};

export function loadSettings(
  files: string[] = settingsFiles(process.cwd()),
): Rules {
  const merged = emptyRules();
  let mode: Mode = DEFAULT_MODE;
  let model: string | null = null;
  let servers: Record<string, StdioServer> = {};
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
    model = parseModel(text, file, isUserSettings(file)) ?? model;
    servers = {...servers, ...parseServers(text, file, isUserSettings(file))};
  }
  cached = merged;
  cachedMode = mode;
  cachedModel = model;
  cachedServers = servers;
  return merged;
}

export function rulesOf(): Rules {
  return cached;
}

export function modeOf(): Mode {
  return cachedMode;
}

export function modelOf(): string | null {
  return cachedModel;
}

export function serversOf(): Record<string, StdioServer> {
  return cachedServers;
}

function remember(key: string, value: string): void {
  const file = userSettingsFile();
  const existing = fs.existsSync(file)
    ? parseObject(fs.readFileSync(file, 'utf8'), file)
    : {};
  makeDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify({...existing, [key]: value}, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function rememberMode(mode: Mode): void {
  remember(MODE_KEY, mode);
  cachedMode = mode;
}

export function rememberModel(id: string): void {
  remember(MODEL_KEY, id);
  cachedModel = id;
}
