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

export function relativeTo(target: string, root: string): string | null {
  const expanded = expandUser(target);
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
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

export function patternScore(pattern: string): number {
  return pattern.split('*').join('').length;
}

const TIE_BREAK: Record<RuleVerdict, number> = {deny: 3, ask: 2, allow: 1};

const WORST: Record<RuleVerdict | 'none', number> = {
  deny: 4,
  ask: 3,
  none: 2,
  allow: 1,
};

function worstRank(verdict: RuleVerdict | null): number {
  return WORST[verdict ?? 'none'];
}

function bestVerdict(rules: Rules, matches: (rule: Rule) => boolean): RuleVerdict | null {
  const lists: [RuleVerdict, Rule[]][] = [
    ['deny', rules.deny],
    ['ask', rules.ask],
    ['allow', rules.allow],
  ];
  let best: RuleVerdict | null = null;
  let bestScore = -1;
  for (const [verdict, list] of lists) {
    for (const rule of list) {
      if (!matches(rule)) continue;
      const score = patternScore(rule.pattern);
      if (score < bestScore) continue;
      if (score > bestScore || best === null || TIE_BREAK[verdict] > TIE_BREAK[best]) {
        best = verdict;
        bestScore = score;
      }
    }
  }
  return best;
}

export function stageVerdict(stage: string, rules: Rules): RuleVerdict | null {
  return bestVerdict(
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
  if (relative === null) return null;
  return bestVerdict(
    rules,
    (rule) => rule.tag === 'edit' && matchPath(rule.pattern, relative),
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
