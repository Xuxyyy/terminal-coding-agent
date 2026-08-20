import {RANK, type Level} from './classify.js';

export type Mode = 'ask-edits' | 'auto-edits';

export const MODES: Mode[] = ['ask-edits', 'auto-edits'];

export const DEFAULT_MODE: Mode = 'auto-edits';

const CUTS: Record<Mode, Level> = {
  'ask-edits': 'observe',
  'auto-edits': 'recoverable',
};

export function withinCut(level: Level | null, mode: Mode): boolean {
  return level !== null && RANK[level] <= RANK[CUTS[mode]];
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}
