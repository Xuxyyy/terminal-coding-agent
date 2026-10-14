import * as fs from 'node:fs';
import * as path from 'node:path';
import {parse} from 'yaml';
import {MODEL_IDS} from './models.js';
import {MODES, type Mode} from './permission/mode.js';
import {accHome} from './projects.js';

export type AgentDefinition = {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
  permissionMode?: Mode;
  file: string;
};

const HEADER_KEYS = ['description', 'model', 'tools', 'permission_mode'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

let cached: AgentDefinition[] = [];

export class AgentDefinitionError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'AgentDefinitionError';
  }
}

export function agentsDir(home: string = accHome()): string {
  return path.join(home, 'agents');
}

export function agentFiles(dir: string = agentsDir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function objectHeader(value: unknown, file: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentDefinitionError(file, 'front matter must be a YAML object');
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function parseAgent(text: string, file: string): AgentDefinition {
  const basename = path.basename(file);
  const name = basename.endsWith('.md') ? basename.slice(0, -3) : basename;
  if (!file.endsWith('.md') || !NAME.test(name)) {
    throw new AgentDefinitionError(
      file,
      `agent name ${JSON.stringify(name)} must start with a letter or digit and use ` +
        'lowercase letters, digits, dashes, and underscores only',
    );
  }

  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new AgentDefinitionError(file, 'must start with a standalone --- delimiter');
  }
  const close = lines.indexOf('---', 1);
  if (close < 0) {
    throw new AgentDefinitionError(file, 'front matter is missing its closing --- delimiter');
  }

  let parsed: unknown;
  try {
    parsed = parse(lines.slice(1, close).join('\n'));
  } catch (error) {
    throw new AgentDefinitionError(
      file,
      `front matter is not valid YAML: ${(error as Error).message}`,
    );
  }
  const header = objectHeader(parsed, file);
  for (const key of Object.keys(header)) {
    if (!HEADER_KEYS.includes(key)) {
      throw new AgentDefinitionError(
        file,
        `front matter has no key ${JSON.stringify(key)}; use ${HEADER_KEYS.join(', ')}`,
      );
    }
  }

  if (!nonEmptyString(header.description)) {
    throw new AgentDefinitionError(file, 'description must be a non-empty string');
  }
  if (
    header.model !== undefined &&
    (typeof header.model !== 'string' || !MODEL_IDS.includes(header.model))
  ) {
    throw new AgentDefinitionError(
      file,
      `model is ${JSON.stringify(header.model)}; use ${MODEL_IDS.join(', ')}`,
    );
  }
  if (
    header.permission_mode !== undefined &&
    (!nonEmptyString(header.permission_mode) ||
      !MODES.includes(header.permission_mode as Mode))
  ) {
    throw new AgentDefinitionError(
      file,
      `permission_mode is ${JSON.stringify(header.permission_mode)}; use ${MODES.join(', ')}`,
    );
  }

  let tools: string[] | undefined;
  if (header.tools !== undefined) {
    if (!Array.isArray(header.tools)) {
      throw new AgentDefinitionError(file, 'tools must be an array');
    }
    tools = [];
    for (const value of header.tools) {
      if (!nonEmptyString(value)) {
        throw new AgentDefinitionError(
          file,
          `every tools entry must be a non-empty string, found ${JSON.stringify(value)}`,
        );
      }
      if (value === 'agent') {
        throw new AgentDefinitionError(file, 'tools cannot contain recursive agent access');
      }
      if (tools.includes(value)) {
        throw new AgentDefinitionError(file, `tools contains duplicate ${JSON.stringify(value)}`);
      }
      tools.push(value);
    }
  }

  const prompt = lines.slice(close + 1).join('\n').trim();
  if (prompt === '') {
    throw new AgentDefinitionError(file, 'body must contain a non-empty prompt');
  }

  return {
    name,
    description: header.description,
    prompt,
    ...(header.model === undefined ? {} : {model: header.model as string}),
    ...(tools === undefined ? {} : {tools}),
    ...(header.permission_mode === undefined
      ? {}
      : {permissionMode: header.permission_mode as Mode}),
    file,
  };
}

export function loadAgents(files: string[] = agentFiles()): AgentDefinition[] {
  cached = [];
  const loaded = [...files]
    .sort()
    .map((file) => {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        throw new AgentDefinitionError(file, `could not be read: ${(error as Error).message}`);
      }
      return parseAgent(text, file);
    });
  cached = loaded;
  return loaded;
}

export function agentsOf(): AgentDefinition[] {
  return cached;
}
