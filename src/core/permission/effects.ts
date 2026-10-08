export type WriteTarget = {path: string; destructive?: boolean; destroys?: boolean};

export type CommandEffects = {
  known: boolean;
  reads: string[];
  writes: WriteTarget[];
  dependencies: string[];
  changes: string[];
  trees: string[];
};

export function emptyEffects(known = true): CommandEffects {
  return {known, reads: [], writes: [], dependencies: [], changes: [], trees: []};
}
