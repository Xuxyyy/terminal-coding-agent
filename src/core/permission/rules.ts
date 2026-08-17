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

export function ruleVerdict(command: string, rules: Rules): RuleVerdict | null {
  const stages = normalizedStages(command);
  if (stages === null) {
    return matchesAny(rules.deny, command.trim()) ? 'deny' : null;
  }
  if (stages.some((stage) => matchesAny(rules.deny, stage))) return 'deny';
  if (stages.some((stage) => matchesAny(rules.ask, stage))) return 'ask';
  if (stages.length && stages.every((stage) => matchesAny(rules.allow, stage))) {
    return 'allow';
  }
  return null;
}
