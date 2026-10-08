import {TIER_RANK, type Tier} from './classify.js';

export type Mode = 'ask-edits' | 'auto-edits' | 'auto';

export const MODES: Mode[] = ['ask-edits', 'auto-edits', 'auto'];

export const DEFAULT_MODE: Mode = 'auto';

const STRICTNESS: Record<Mode, number> = {
  'ask-edits': 2,
  'auto-edits': 1,
  auto: 0,
};

const CUTS: Record<Mode, Exclude<Tier, 'needs-checking'>> = {
  'ask-edits': 'observe',
  'auto-edits': 'recoverable',
  auto: 'recoverable',
};

const ABOVE: Record<Mode, 'ask' | 'judge'> = {
  'ask-edits': 'ask',
  'auto-edits': 'ask',
  auto: 'judge',
};

export function aboveCut(mode: Mode): 'ask' | 'judge' {
  return ABOVE[mode];
}

export function withinCut(tier: Tier, mode: Mode): boolean {
  return TIER_RANK[tier] <= TIER_RANK[CUTS[mode]];
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}

export function stricterMode(parent: Mode, configured: Mode): Mode {
  return STRICTNESS[parent] >= STRICTNESS[configured] ? parent : configured;
}
