import assert from 'node:assert/strict';
import test from 'node:test';
import {abortError, connectionError, statusError} from '../fakes.js';
import {backoff, isRetryable, withRetry} from '../../core/retry.js';

const noSleep = async () => {};

function counted(behaviour: (attempt: number) => unknown) {
  let calls = 0;
  const run = async (): Promise<unknown> => {
    calls += 1;
    const result = behaviour(calls);
    if (result instanceof Error) throw result;
    return result;
  };
  return {run, calls: () => calls};
}

function recorder() {
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  return {slept, sleep};
}

test('a connection error is retryable', () => {
  const reset = Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'});

  assert.equal(isRetryable(connectionError()), true);
  assert.equal(isRetryable(reset), true);
});

test('rate limits and server errors are retryable', () => {
  assert.equal(isRetryable(statusError(429)), true);
  assert.equal(isRetryable(statusError(500)), true);
  assert.equal(isRetryable(statusError(503)), true);
});

test('a bad request is not retryable', () => {
  assert.equal(isRetryable(statusError(400)), false);
  assert.equal(isRetryable(statusError(401)), false);
  assert.equal(isRetryable(statusError(403)), false);
  assert.equal(isRetryable(statusError(404)), false);
});

test('an abort is not retryable', () => {
  assert.equal(isRetryable(abortError('AbortError')), false);
  assert.equal(isRetryable(abortError('APIUserAbortError')), false);
});

test('backoff doubles from one second', () => {
  assert.deepEqual([backoff(0), backoff(1), backoff(2)], [1_000, 2_000, 4_000]);
});

test('withRetry returns the first success without sleeping', async () => {
  const attempt = counted(() => 'ok');
  const clock = recorder();

  const value = await withRetry(attempt.run, {sleep: clock.sleep});

  assert.equal(value, 'ok');
  assert.equal(attempt.calls(), 1);
  assert.deepEqual(clock.slept, []);
});

test('withRetry recovers on a later attempt', async () => {
  const attempt = counted((n) => (n < 3 ? statusError(500) : 'ok'));

  const value = await withRetry(attempt.run, {sleep: noSleep});

  assert.equal(value, 'ok');
  assert.equal(attempt.calls(), 3);
});

test('withRetry retries three times, then gives up', async () => {
  const attempt = counted(() => statusError(500));
  const clock = recorder();

  await assert.rejects(
    withRetry(attempt.run, {sleep: clock.sleep}),
    /status 500/,
  );

  assert.equal(attempt.calls(), 4);
  assert.deepEqual(clock.slept, [1_000, 2_000, 4_000]);
});

test('withRetry stops at the first error that is not retryable', async () => {
  const attempt = counted(() => statusError(400));

  await assert.rejects(withRetry(attempt.run, {sleep: noSleep}), /status 400/);

  assert.equal(attempt.calls(), 1);
});

test('an interrupt beats a retry', async () => {
  const controller = new AbortController();
  const attempt = counted(() => statusError(500));
  const slept: number[] = [];

  await assert.rejects(
    withRetry(attempt.run, {
      signal: controller.signal,
      sleep: async (ms) => {
        slept.push(ms);
        controller.abort();
      },
    }),
    /status 500/,
  );

  assert.equal(attempt.calls(), 1);
  assert.deepEqual(slept, [1_000]);
});

test('a signal already aborted stops before the first retry', async () => {
  const attempt = counted(() => statusError(500));

  await assert.rejects(
    withRetry(attempt.run, {signal: AbortSignal.abort(), sleep: noSleep}),
    /status 500/,
  );

  assert.equal(attempt.calls(), 1);
});
