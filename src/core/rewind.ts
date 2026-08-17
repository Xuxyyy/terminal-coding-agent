import {restoreFiles, restorePlan, type RestoreCounts} from './history.js';
import {lastUsageOf, messagesOf, viewOf} from './records.js';
import {restoreMessages, setMeasured, type Session} from './session.js';
import type {SessionStore} from './store.js';

export type RewindOutcome = {counts: RestoreCounts; kept: unknown[]};

export const REWIND_NOTE =
  'Some earlier turns were removed. What the turns above say about a file, that it exists or ' +
  'what it holds, may be out of date, so read it from disk before relying on it. What they ' +
  'asked for still stands: it is the workspace that may have moved on, not the goal.';

export function rewindPlan(
  store: SessionStore,
  at: number,
): Map<string, string | null> {
  return restorePlan(store.records(), at);
}

export function rewindSession(
  store: SessionStore,
  session: Session,
  at: number,
): RewindOutcome {
  const counts = restoreFiles(store.dir, session.root, rewindPlan(store, at));
  store.rewind(at);
  const after = store.records();
  restoreMessages(session, messagesOf(after));
  setMeasured(session, lastUsageOf(after)?.total ?? 0);
  session.messages.push({role: 'user', content: REWIND_NOTE});
  store.seed(session.messages);
  return {counts, kept: viewOf(after)};
}
