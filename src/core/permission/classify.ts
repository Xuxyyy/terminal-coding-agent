import * as path from 'node:path';
import {observationText, observeStage} from './observe.js';
import {expandUser, insideRoot, isProtectedPath, realPath} from './protected.js';
import {
  basename,
  commandParts,
  maskQuotedRedirects,
  splitStages,
  unquoteTarget,
} from './stages.js';

export type Level = 'observe' | 'recoverable' | 'protected' | 'destroy' | 'escape';

export type Unclassified = null;

export type Classification = {level: Level | Unclassified; reason: string};

export const RANK: Record<Level, number> = {
  observe: 0,
  recoverable: 1,
  protected: 2,
  destroy: 3,
  escape: 4,
};

const READ_ONLY_EXTERNAL_OPTIONS: Record<string, readonly string[]> = {
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
const REDIRECT_TARGET_PATTERN = /(?:\d*|&)>>?\s*/g;
const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{.*\|.*&\s*\}/;

const UNKNOWN: Classification = {level: null, reason: ''};

function executableOf(parts: string[]): string {
  return parts.length ? basename(parts[0]) : '';
}

function uncertainTraversal(target: string, cwd: string): boolean {
  const expanded = expandUser(target);
  let prefix = path.isAbsolute(expanded) ? path.parse(expanded).root : cwd;
  for (const part of expanded.split(path.sep)) {
    // Normalizing before resolving a symlink can hide the directory '..' visits.
    if (part === '..' && realPath(prefix) !== path.resolve(prefix)) return true;
    prefix = path.join(prefix, part);
  }
  return false;
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
  options: {reading?: boolean; destructive?: boolean; destroys?: boolean; cwd?: string} = {},
): Classification {
  const {reading = false, destructive = false, destroys = false, cwd = root} = options;
  const outside = reading
    ? `reads '${target}' outside the project`
    : `'${target}' is outside the project`;
  const expanded = expandUser(target);
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
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
  const cleaned = observationText(maskQuotedRedirects(stage), true);
  const targets: string[] = [];
  for (const match of cleaned.matchAll(REDIRECT_TARGET_PATTERN)) {
    const start = match.index + match[0].length;
    let end = start;
    let quote = '';
    while (end < stage.length) {
      const character = stage[end];
      if (!quote && /[\s;|&<>]/.test(character)) break;
      if (character === '\\' && quote !== "'" && end + 1 < stage.length) { end += 2; continue; }
      if (!quote && (character === "'" || character === '"')) quote = character;
      else if (character === quote) quote = '';
      end += 1;
    }
    if (end > start) targets.push(unquoteTarget(stage.slice(start, end)));
  }
  const executable = executableOf(parts);
  const unsafeRead = hasOption(parts, READ_ONLY_EXTERNAL_OPTIONS[executable]);
  if (WRITE_COMMANDS.has(executable) || unsafeRead) {
    targets.push(...parts.slice(1).filter((part) => !part.startsWith('-')));
  }
  return targets;
}

function isProjectRunner(stage: string, parts: string[]): boolean {
  if (SUBSTITUTION_PATTERN.test(stage)) return false;
  const subcommands = PROJECT_RUNNERS[executableOf(parts)];
  return Boolean(subcommands && parts.length > 1 && subcommands.includes(parts[1]));
}

function classifyStage(stage: string, root: string, cwd: string | null): Classification {
  const normalized = commandParts(stage);
  if (normalized === null) return UNKNOWN;
  const observation = observeStage(stage);
  const parts = observation?.lookup && observation.known ? observation.parts : normalized;
  const escaping = escapingExecutable(parts);
  if (escaping !== null) return {level: 'escape', reason: escaping};

  const reads = observation?.reads ?? [];
  const outside = worst(reads.map((read) => targetClassification(read, root, {reading: true, cwd: cwd ?? root})));
  if (outside.level === 'escape') return outside;
  const targets = [...stageTargets(stage, parts), ...(observation?.writes ?? [])];
  if (targets.length) {
    if (SUBSTITUTION_PATTERN.test(stage)) {
      return {level: 'escape', reason: 'writes to a target that cannot be determined'};
    }
    const executable = executableOf(parts);
    const destructive = DESTRUCTIVE_COMMANDS.has(executable);
    const destroys = destructive || hasOption(parts, DESTRUCTIVE_OPTIONS[executable]);
    // Directory tracking must not weaken the existing write guardrails.
    const classification = worst(targets.flatMap((target) => [
      targetClassification(target, root, {destructive, destroys}),
      targetClassification(target, root, {destructive, destroys, cwd: cwd ?? root}),
    ]));
    if (cwd === null && classification.level !== 'escape' && targets.some((target) => !path.isAbsolute(expandUser(target)))) return UNKNOWN;
    if (classification.level !== 'escape' && targets.some((target) => uncertainTraversal(target, cwd ?? root))) return UNKNOWN;
    if (classification.level === 'recoverable' && targets.some((target) => /[*?{}\[\]]/.test(target))) return UNKNOWN;
    return classification;
  }

  if (observation?.known) {
    if (cwd === null && reads.some((read) => !path.isAbsolute(expandUser(read)))) return UNKNOWN;
    if (reads.some((read) => uncertainTraversal(read, cwd ?? root))) return UNKNOWN;
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
  const classifications: Classification[] = [];
  let cwd: string | null = realPath(root);
  let changedDirectory = false;
  let previousSeparator = '';
  for (const {text, separator} of stages) {
    if (!text.trim()) continue;
    const classification = classifyStage(text, root, cwd);
    classifications.push(classification);
    const observation = observeStage(text);
    if (observation?.directory !== undefined || executableOf(commandParts(text) ?? []) === 'cd') {
      changedDirectory = true;
      const target = observation?.directory === undefined ? null : expandUser(observation.directory);
      cwd = target !== null && classification.level === 'observe' && (cwd !== null || path.isAbsolute(target))
        ? path.resolve(cwd ?? root, target) : null;
      // Shell cd and file reads handle '..' through symlinks differently.
      if (cwd !== null && realPath(cwd) !== cwd) cwd = null;
      if (['||', '|', '|&'].includes(previousSeparator)) cwd = null;
    }
    // A failed cd can skip an && branch. Later branches may run in either directory.
    if (changedDirectory && separator && separator !== '&&') cwd = null;
    previousSeparator = separator;
  }
  return classifications.length ? worst(classifications) : UNKNOWN;
}

export function classifyWrite(target: string, root: string): Classification {
  return targetClassification(target, root);
}

export function classifyRead(target: string, root: string): Classification {
  const classification = targetClassification(target, root, {reading: true});
  if (classification.level === 'escape') return classification;
  return {level: 'observe', reason: ''};
}
