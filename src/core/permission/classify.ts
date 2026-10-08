import * as fs from 'node:fs';
import * as path from 'node:path';
import {analyzeStage, type StageAnalysis} from './analyze.js';
import {affectedPaths} from './recoverable.js';
import {expandUser, insideRoot, isProtectedPath, realPath} from './protected.js';
import {
  basename,
  splitStages,
} from './stages.js';

export type Tier = 'observe' | 'recoverable' | 'needs-checking';
export type CheckCause = 'protected' | 'destroy' | 'escape' | 'unknown';

export type Classification = {
  tier: Tier;
  reason: string;
  cause: CheckCause | null;
  restrictions: {
    mustCheck: boolean;
    onceOnly: boolean;
  };
};

export const TIER_RANK: Record<Tier, number> = {
  observe: 0,
  recoverable: 1,
  'needs-checking': 2,
};

function automatic(tier: 'observe' | 'recoverable', reason = ''): Classification {
  return {tier, reason, cause: null, restrictions: {mustCheck: false, onceOnly: false}};
}

function needsChecking(cause: CheckCause, reason = ''): Classification {
  const restricted = cause === 'escape';
  return {
    tier: 'needs-checking', reason, cause,
    restrictions: {mustCheck: restricted, onceOnly: restricted},
  };
}

const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{.*\|.*&\s*\}/;

const UNKNOWN = needsChecking('unknown');

function executableOf(parts: string[]): string {
  return parts.length ? basename(parts[0]) : '';
}

function uncertainTraversal(target: string, cwd: string): boolean {
  const expanded = expandUser(target);
  let prefix = path.isAbsolute(expanded) ? path.parse(expanded).root : cwd;
  for (const part of expanded.split(path.sep)) {
    if (part === '..') {
      if (realPath(prefix) !== path.resolve(prefix)) return true;
      try { if (fs.lstatSync(prefix).isSymbolicLink()) return true; }
      catch {}
    }
    prefix = path.join(prefix, part);
  }
  return false;
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
  if (!insideRoot(candidate, root)) return needsChecking('escape', outside);
  if (destructive && realPath(candidate) === realPath(root)) {
    return needsChecking('escape', `'${target}' is the project root itself`);
  }
  const verb = destroys ? 'deletes' : 'changes';
  if (isProtectedPath(candidate, root)) {
    return needsChecking('protected', `${verb} '${target}', a protected path`);
  }
  if (destroys) {
    return needsChecking('destroy', `deletes '${target}', which cannot be undone`);
  }
  return automatic('recoverable', `changes '${target}', which git can undo`);
}

function worst(items: Classification[]): Classification {
  const restricted = items.find((item) => item.restrictions.mustCheck || item.restrictions.onceOnly);
  if (restricted) {
    return {...restricted, restrictions: {
      mustCheck: items.some((item) => item.restrictions.mustCheck),
      onceOnly: items.some((item) => item.restrictions.onceOnly),
    }};
  }
  if (items.some((item) => item.cause === 'unknown')) return UNKNOWN;
  return items.reduce((left, right) => {
    if (TIER_RANK[right.tier] !== TIER_RANK[left.tier]) {
      return TIER_RANK[right.tier] > TIER_RANK[left.tier] ? right : left;
    }
    return right.cause === 'destroy' && left.cause === 'protected' ? right : left;
  }, automatic('observe'));
}

function classifyStage(effects: StageAnalysis | null, root: string, cwd: string | null, priorChanges: string[], priorDependencies: string[], concurrent: boolean): Classification {
  if (effects === null) return UNKNOWN;
  const escaping = escapingExecutable(effects.parts);
  if (escaping !== null) return needsChecking('escape', escaping);
  const {reads, writes: targets, dependencies, changes: changed} = effects;
  if (targets.length && effects.substitution) {
    return needsChecking('escape', 'writes to a target that cannot be determined');
  }
  const outside = worst(reads.map((read) => targetClassification(read, root, {reading: true, cwd: cwd ?? root})));
  if (outside.restrictions.mustCheck) return outside;
  const classification = worst(targets.flatMap((target) => [
    targetClassification(target.path, root, target),
    targetClassification(target.path, root, {...target, cwd: cwd ?? root}),
  ]));
  if (classification.restrictions.mustCheck) return classification;

  const paths = [...reads, ...targets.map((target) => target.path)];
  const affected = affectedPaths(dependencies, priorChanges) ||
    (concurrent && affectedPaths(priorDependencies, changed)) || effects.selfAffected;
  priorChanges.push(...changed);
  priorDependencies.push(...dependencies);
  if (cwd === null && paths.some((target) => !path.isAbsolute(expandUser(target)))) return UNKNOWN;
  if (paths.some((target) => uncertainTraversal(target, cwd ?? root))) return UNKNOWN;
  if (affected) return UNKNOWN;

  const known = effects.known || effects.runnerSyntaxKnown;
  if (targets.length) {
    if (classification.tier === 'recoverable' && (!known || paths.some((target) => /[*?{}\[\]]/.test(target)))) return UNKNOWN;
    return classification;
  }
  if (known && effects.projectRunner) {
    return automatic('recoverable', `runs '${effects.projectRunner}', which stays inside the project`);
  }
  return known ? automatic('observe', '') : UNKNOWN;
}

export function classifyCommand(command: string, root: string): Classification {
  if (FORK_BOMB_PATTERN.test(command)) return needsChecking('escape', 'fork bomb');
  const stages = splitStages(command);
  if (stages === null) return UNKNOWN;
  const classifications: Classification[] = [];
  let cwd: string | null = realPath(root);
  let changedDirectory = false;
  let previousSeparator = '';
  const changes: string[] = [];
  const dependencies: string[] = [];
  const concurrent = stages.some(({separator}) => ['|', '|&', '&'].includes(separator));
  for (const {text, separator} of stages) {
    if (!text.trim()) continue;
    const effects = analyzeStage(text, root, cwd ?? root);
    const classification = classifyStage(effects, root, cwd, changes, dependencies, concurrent);
    classifications.push(classification);
    if (effects?.changesDirectory) {
      changedDirectory = true;
      const target = effects.directory === undefined ? null : expandUser(effects.directory);
      cwd = target !== null && classification.tier === 'observe' && (cwd !== null || path.isAbsolute(target))
        ? path.resolve(cwd ?? root, target) : null;
      if (cwd !== null && realPath(cwd) !== cwd) cwd = null;
      if (['||', '|', '|&'].includes(previousSeparator)) cwd = null;
    }
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
  if (classification.restrictions.mustCheck) return classification;
  return automatic('observe', '');
}
