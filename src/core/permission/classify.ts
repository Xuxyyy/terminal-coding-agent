import * as path from 'node:path';
import {expandUser, insideRoot, isProtectedPath, realPath} from './protected.js';
import {basename, commandParts, discardNoiseRedirects, splitStages} from './stages.js';

export type Level = 'observe' | 'recoverable' | 'protected' | 'destroy' | 'escape';

export type Unclassified = null;

export type Classification = {level: Level | Unclassified; reason: string};

const RANK: Record<Level, number> = {
  observe: 0,
  recoverable: 1,
  protected: 2,
  destroy: 3,
  escape: 4,
};

const READ_ONLY_COMMANDS = new Set([
  'cat', 'cd', 'diff', 'echo', 'find', 'grep', 'head', 'ls',
  'od', 'pwd', 'rg', 'sort', 'tail', 'test', 'wc',
]);
const READ_ONLY_GIT_COMMANDS = new Set(['diff', 'log', 'ls-files', 'show', 'status']);
const READ_ONLY_EXTERNAL_OPTIONS: Record<string, readonly string[]> = {
  git: ['--ext-diff', '--textconv'],
  rg: ['--pre'],
  sort: ['-o', '--output'],
  find: ['-delete', '-exec', '-execdir', '-fls', '-fprint', '-fprintf', '-ok', '-okdir'],
};

const WRITE_COMMANDS = new Set(['cp', 'ln', 'mkdir', 'mv', 'rm', 'rmdir', 'tee', 'touch']);
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir']);
const DESTRUCTIVE_OPTIONS: Record<string, readonly string[]> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir'],
};

const PROJECT_RUNNERS: Record<string, readonly string[]> = {
  npm: ['test', 'run'],
  pnpm: ['test', 'run'],
  yarn: ['test', 'run'],
};

const SUBSTITUTION_PATTERN = /[`$()]/;
const REDIRECT_PATTERN = /[<>]/;
const REDIRECT_TARGET_PATTERN = /(?:\d*|&)>>?\s*([^\s;|&<>]+)/g;
const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{.*\|.*&\s*\}/;

const UNKNOWN: Classification = {level: null, reason: ''};

function executableOf(parts: string[]): string {
  return parts.length ? basename(parts[0]) : '';
}

function hasOption(parts: string[], options: readonly string[] | undefined): boolean {
  if (!options) return false;
  return parts.slice(1).some((part) =>
    options.some((option) => part === option || part.startsWith(`${option}=`)),
  );
}

function escapingExecutable(parts: string[]): string | null {
  const executable = executableOf(parts);
  if (executable === 'sudo') return 'sudo';
  if (executable.startsWith('mkfs')) return 'filesystem format (mkfs)';
  if (executable === 'dd' && parts.slice(1).some((part) => part.startsWith('of='))) {
    return 'raw disk write (dd of=)';
  }
  if (executable === 'git' && parts[1] === 'push') return 'git push';
  return null;
}

function targetClassification(
  target: string,
  root: string,
  options: {reading?: boolean; destructive?: boolean; destroys?: boolean} = {},
): Classification {
  const {reading = false, destructive = false, destroys = false} = options;
  const outside = reading
    ? `reads '${target}' outside the project`
    : `'${target}' is outside the project`;
  const expanded = expandUser(target);
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
  if (!insideRoot(candidate, root)) return {level: 'escape', reason: outside};
  if (destructive && realPath(candidate) === realPath(root)) {
    return {level: 'escape', reason: `'${target}' is the project root itself`};
  }
  const verb = destroys ? 'deletes' : 'changes';
  if (isProtectedPath(candidate, root)) {
    return {level: 'protected', reason: `${verb} '${target}', a protected path`};
  }
  if (destroys) {
    return {level: 'destroy', reason: `deletes '${target}', which cannot be undone`};
  }
  return {level: 'recoverable', reason: `changes '${target}', which git can undo`};
}

function worst(items: Classification[]): Classification {
  const known = items.filter((item) => item.level !== null);
  if (known.length !== items.length) {
    return known.find((item) => item.level === 'escape') ?? UNKNOWN;
  }
  if (!known.length) return {level: 'observe', reason: ''};
  return known.reduce((left, right) =>
    RANK[right.level as Level] > RANK[left.level as Level] ? right : left,
  );
}

function stageTargets(stage: string, parts: string[]): string[] {
  const cleaned = discardNoiseRedirects(stage);
  const targets = [...cleaned.matchAll(REDIRECT_TARGET_PATTERN)].map((match) => match[1]);
  const executable = executableOf(parts);
  const unsafeRead =
    READ_ONLY_COMMANDS.has(executable) &&
    hasOption(parts, READ_ONLY_EXTERNAL_OPTIONS[executable]);
  if (WRITE_COMMANDS.has(executable) || unsafeRead) {
    targets.push(...parts.slice(1).filter((part) => !part.startsWith('-')));
  }
  return targets;
}

function isReadOnlyStage(stage: string, parts: string[]): boolean {
  if (SUBSTITUTION_PATTERN.test(stage)) return false;
  if (REDIRECT_PATTERN.test(discardNoiseRedirects(stage))) return false;
  if (!parts.length) return false;
  const executable = executableOf(parts);
  if (parts[0] !== executable) return false;
  if (hasOption(parts, READ_ONLY_EXTERNAL_OPTIONS[executable])) return false;
  if (READ_ONLY_COMMANDS.has(executable)) return true;
  return (
    executable === 'git' &&
    parts.length > 1 &&
    READ_ONLY_GIT_COMMANDS.has(parts[1]) &&
    !parts.slice(2).some((part) => part.startsWith('--output'))
  );
}

function isProjectRunner(stage: string, parts: string[]): boolean {
  if (SUBSTITUTION_PATTERN.test(stage)) return false;
  const subcommands = PROJECT_RUNNERS[executableOf(parts)];
  return Boolean(subcommands && parts.length > 1 && subcommands.includes(parts[1]));
}

function classifyStage(stage: string, root: string): Classification {
  const parts = commandParts(stage);
  if (parts === null) return UNKNOWN;
  const escaping = escapingExecutable(parts);
  if (escaping !== null) return {level: 'escape', reason: escaping};

  const targets = stageTargets(stage, parts);
  if (targets.length) {
    if (SUBSTITUTION_PATTERN.test(stage)) {
      return {level: 'escape', reason: 'writes to a target that cannot be determined'};
    }
    const executable = executableOf(parts);
    const destructive = DESTRUCTIVE_COMMANDS.has(executable);
    const destroys = destructive || hasOption(parts, DESTRUCTIVE_OPTIONS[executable]);
    return worst(
      targets.map((target) => targetClassification(target, root, {destructive, destroys})),
    );
  }

  if (isReadOnlyStage(stage, parts)) {
    const reads = parts.slice(1).filter((part) => !part.startsWith('-'));
    const outside = worst(reads.map((read) => targetClassification(read, root, {reading: true})));
    if (outside.level === 'escape') return outside;
    return {level: 'observe', reason: ''};
  }

  if (isProjectRunner(stage, parts)) {
    return {
      level: 'recoverable',
      reason: `runs '${parts[0]} ${parts[1]}', which stays inside the project`,
    };
  }

  return UNKNOWN;
}

export function classifyCommand(command: string, root: string): Classification {
  if (FORK_BOMB_PATTERN.test(command)) return {level: 'escape', reason: 'fork bomb'};
  const stages = splitStages(command);
  if (stages === null) return UNKNOWN;
  const texts = stages.map((stage) => stage.text).filter((text) => text.trim());
  if (!texts.length) return UNKNOWN;
  return worst(texts.map((text) => classifyStage(text, root)));
}

export function classifyWrite(target: string, root: string): Classification {
  return targetClassification(target, root);
}
