import * as path from 'node:path';
import type {Rule, Rules} from '../settings.js';
import {expandUser, insideRoot, realPath} from './protected.js';
import {commandParts, splitStages} from './stages.js';

export type RuleVerdict = 'deny' | 'ask' | 'allow';

export function matchPattern(pattern: string, text: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(text);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchPath(pattern: string, relative: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  const expanded = pattern.endsWith('/') ? `${pattern}**` : pattern;
  const source = expanded
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(relative);
}

export function candidatePath(target: string, root: string): string {
  const expanded = expandUser(target);
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

export function absolutePattern(pattern: string): boolean {
  return pattern.startsWith('/') || pattern.startsWith('~/') || pattern === '~';
}

function pathForms(value: string): string[] {
  const real = realPath(value);
  return real === value ? [value] : [value, real];
}

export function relativeTo(target: string, root: string): string | null {
  const candidate = candidatePath(target, root);
  if (!insideRoot(candidate, root)) return null;
  return path.relative(realPath(root), realPath(candidate)).split(path.sep).join('/');
}

export function normalizedStages(command: string): string[] | null {
  const stages = splitStages(command);
  if (stages === null) return null;
  const normalized: string[] = [];
  for (const stage of stages) {
    const text = stage.text.trim();
    if (!text) continue;
    const parts = commandParts(text);
    if (parts === null) return null;
    normalized.push(parts.join(' '));
  }
  return normalized;
}

function matchesAny(list: Rule[], text: string): boolean {
  return list.some((rule) => rule.tag === 'bash' && matchPattern(rule.pattern, text));
}

const WORST: Record<RuleVerdict | 'none', number> = {
  deny: 4,
  ask: 3,
  none: 2,
  allow: 1,
};

function worstRank(verdict: RuleVerdict | null): number {
  return WORST[verdict ?? 'none'];
}

function listVerdict(rules: Rules, matches: (rule: Rule) => boolean): RuleVerdict | null {
  const lists: [RuleVerdict, Rule[]][] = [
    ['deny', rules.deny],
    ['ask', rules.ask],
    ['allow', rules.allow],
  ];
  for (const [verdict, list] of lists) {
    if (list.some(matches)) return verdict;
  }
  return null;
}

export function stageVerdict(stage: string, rules: Rules): RuleVerdict | null {
  return listVerdict(
    rules,
    (rule) => rule.tag === 'bash' && matchPattern(rule.pattern, stage),
  );
}

export function pathVerdict(
  target: string,
  root: string,
  rules: Rules,
): RuleVerdict | null {
  const relative = relativeTo(target, root);
  if (relative !== null) {
    return listVerdict(
      rules,
      (rule) => rule.tag === 'edit' && matchPath(rule.pattern, relative),
    );
  }
  const forms = pathForms(candidatePath(target, root));
  return listVerdict(
    rules,
    (rule) =>
      rule.tag === 'edit' &&
      absolutePattern(rule.pattern) &&
      pathForms(expandUser(rule.pattern)).some((pattern) =>
        forms.some((form) => matchPath(pattern, form)),
      ),
  );
}

export function ruleVerdict(command: string, rules: Rules): RuleVerdict | null {
  const stages = normalizedStages(command);
  if (stages === null) {
    return matchesAny(rules.deny, command.trim()) ? 'deny' : null;
  }
  if (!stages.length) return null;
  let worst: RuleVerdict | null = 'allow';
  for (const stage of stages) {
    const verdict = stageVerdict(stage, rules);
    if (worstRank(verdict) > worstRank(worst)) worst = verdict;
  }
  return worst;
}
