/** A target and the kind of change made to it, before assigning permission tiers. */
export type WriteTarget = {path: string; destructive?: boolean; destroys?: boolean};

/** Shared evidence from command analyzers. Unknown effects never mean no effects. */
export type CommandEffects = {
  known: boolean;
  reads: string[];
  writes: WriteTarget[];
  // Filesystem facts used by this command, paths it changes, and trees it walks.
  dependencies: string[];
  changes: string[];
  trees: string[];
};

export function emptyEffects(known = true): CommandEffects {
  return {known, reads: [], writes: [], dependencies: [], changes: [], trees: []};
}
