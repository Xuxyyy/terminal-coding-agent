import {RANK, type Level} from './classify.js';

export type Mode = 'read-only' | 'ask-edits' | 'auto-edits';

export type Cut = {allowUpTo: Level; above: 'ask' | 'deny'};

export const MODES: Mode[] = ['read-only', 'ask-edits', 'auto-edits'];

export const DEFAULT_MODE: Mode = 'auto-edits';

const CUTS: Record<Mode, Cut> = {
  'read-only': {allowUpTo: 'observe', above: 'deny'},
  'ask-edits': {allowUpTo: 'observe', above: 'ask'},
  'auto-edits': {allowUpTo: 'recoverable', above: 'ask'},
};

export function cutOf(mode: Mode): Cut {
  return CUTS[mode];
}

export function withinCut(level: Level | null, mode: Mode): boolean {
  return level !== null && RANK[level] <= RANK[CUTS[mode].allowUpTo];
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}
