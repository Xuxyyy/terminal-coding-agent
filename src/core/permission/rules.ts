import type {Rules} from '../settings.js';
import {commandParts, splitStages} from './stages.js';

export type RuleVerdict = 'deny' | 'ask' | 'allow';

export function matchPattern(pattern: string, text: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(text);
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

function matchesAny(patterns: string[], text: string): boolean {
  return patterns.some((pattern) => matchPattern(pattern, text));
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

export function stageVerdict(stage: string, rules: Rules): RuleVerdict | null {
  const lists: [RuleVerdict, string[]][] = [
    ['deny', rules.deny],
    ['ask', rules.ask],
    ['allow', rules.allow],
  ];
  let best: RuleVerdict | null = null;
  let bestScore = -1;
  for (const [verdict, patterns] of lists) {
    for (const pattern of patterns) {
      if (!matchPattern(pattern, stage)) continue;
      const score = patternScore(pattern);
      if (score < bestScore) continue;
      if (score > bestScore || best === null || TIE_BREAK[verdict] > TIE_BREAK[best]) {
        best = verdict;
        bestScore = score;
      }
    }
  }
  return best;
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
