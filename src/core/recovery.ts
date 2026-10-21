import type {AssistantResponse} from './client.js';
import {errorCategory, isRetryable, RETRIES} from './retry.js';

export type RecoveryAllowances = {
  continuationUsed: boolean;
  contextRecovered: boolean;
};

export type RecoveryState = RecoveryAllowances & {
  attempts: number;
  retries?: number;
  aborted: boolean;
};

export type RecoveryOutcome =
  | {kind: 'response'; response: AssistantResponse}
  | {kind: 'failure'; error: unknown; partial?: AssistantResponse};

export type RecoveryDecision =
  | {action: 'complete'}
  | {action: 'retry'}
  | {action: 'context'}
  | {action: 'continue'; partial: AssistantResponse}
  | {action: 'stop'; reason: 'continuation_exhausted'; partial: AssistantResponse}
  | {action: 'stop'; reason: 'failure' | 'attempts_exhausted'};

export function decideRecovery(
  outcome: RecoveryOutcome,
  state: RecoveryState,
): RecoveryDecision {
  let incomplete: AssistantResponse | undefined;
  if (outcome.kind === 'response') {
    if (outcome.response.finishReason !== 'length' || outcome.response.toolCalls.length) {
      return {action: 'complete'};
    }
    incomplete = outcome.response;
  } else {
    if (state.aborted) return {action: 'stop', reason: 'failure'};
    const {error, partial} = outcome;
    const retryable = isRetryable(error);
    if (partial?.content && !partial.toolCalls.length && retryable) {
      incomplete = partial;
    } else if (errorCategory(error) === 'context_limit') {
      return !state.contextRecovered && !(state.attempts >= (state.retries ?? RETRIES) + 1)
        ? {action: 'context'}
        : {action: 'stop', reason: 'failure'};
    } else if (!retryable) {
      return {action: 'stop', reason: 'failure'};
    } else {
      const retries = state.retries ?? RETRIES;
      return state.attempts > retries
        ? {action: 'stop', reason: retries === 0 ? 'failure' : 'attempts_exhausted'}
        : {action: 'retry'};
    }
  }
  return state.continuationUsed
    ? {action: 'stop', reason: 'continuation_exhausted', partial: incomplete}
    : {action: 'continue', partial: incomplete};
}
