import assert from 'node:assert/strict';
import test from 'node:test';
import {abortError, connectionError, statusError} from '../fakes.js';
import {backoff, errorCategory, errorFields, isRetryable, retryDelay, rootError, withRetry} from '../../core/retry.js';

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

test('native connection errors remain retryable through nested causes', () => {
  for (const error of [
    new TypeError('terminated'),
    new TypeError('fetch failed'),
    Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'}),
    new TypeError('terminated', {cause: new Error('other side closed')}),
    Object.assign(connectionError(), {cause: new Error('socket closed')}),
    new TypeError('fetch failed', {cause: Object.assign(new Error('socket closed'), {code: 'UND_ERR_SOCKET'})}),
  ]) {
    for (const wrapped of [error, new Error('request failed', {cause: new Error('stream failed', {cause: error})})]) {
      assert.equal(errorCategory(wrapped), 'connection');
      assert.equal(isRetryable(wrapped), true);
    }
  }
});

test('error extraction preserves native and non-enumerable fields without losing wrapper metadata', () => {
  const cause = new TypeError('terminated');
  Object.defineProperty(cause, 'code', {value: 'UND_ERR_SOCKET'});
  const headers = new Headers({'retry-after-ms': '25'});
  const error = Object.assign(new Error('request failed', {cause}), {status: 503, headers, category: 'connection', type: 'transport_error'});

  assert.deepEqual(errorFields(error), {
    name: 'Error', message: 'request failed', cause, status: 503, headers, category: 'connection', type: 'transport_error',
  });
  assert.equal(errorFields(cause).code, 'UND_ERR_SOCKET');
  assert.deepEqual(rootError(error), {
    name: 'TypeError', message: 'terminated', code: 'UND_ERR_SOCKET', cause: undefined,
    status: 503, headers, category: 'connection', type: 'transport_error',
  });
  assert.equal(retryDelay(error, 0), 25);
  assert.equal(error.cause, cause);
});

test('cause traversal tolerates missing fields, primitive causes and cycles', () => {
  for (const error of [undefined, null, 'terminated', 0, {cause: 'terminated'}, {cause: {}}]) {
    assert.equal(errorCategory(error), 'permanent');
    assert.doesNotThrow(() => rootError(error));
  }
  const error = new TypeError('terminated');
  const cause = new Error('socket closed', {cause: error});
  error.cause = cause;
  assert.equal(errorCategory(error), 'connection');
  assert.equal(rootError(error).message, 'socket closed');
  assert.deepEqual(rootError({status: 503, cause: {status: undefined, headers: undefined}}).status, 503);
});

test('non-retryable errors retain priority over nested connection evidence', async () => {
  const socket = Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'});
  const cases: Array<[Error, string]> = [
    [Object.assign(abortError(), {cause: socket}), 'cancelled'],
    [Object.assign(statusError(401), {cause: socket}), 'authentication'],
    [Object.assign(statusError(403), {cause: socket}), 'authentication'],
    [Object.assign(statusError(402), {cause: socket}), 'quota'],
    [Object.assign(statusError(429, 'daily quota reached'), {cause: socket}), 'quota'],
    [Object.assign(new Error('insufficient quota', {cause: socket}), {code: 'insufficient_quota'}), 'quota'],
    [Object.assign(new Error('invalid key', {cause: socket}), {code: 'invalid_api_key'}), 'authentication'],
    [Object.assign(new Error('context length exceeded', {cause: socket}), {code: 'context_length_exceeded'}), 'context_limit'],
    [Object.assign(statusError(400), {cause: socket}), 'permanent'],
    [Object.assign(statusError(404), {cause: socket}), 'permanent'],
    [Object.assign(statusError(501), {cause: socket}), 'permanent'],
    [Object.assign(new Error('unsupported configuration', {cause: socket}), {category: 'permanent'}), 'permanent'],
    [new TypeError('cannot read properties of undefined'), 'permanent'],
  ];
  for (const [error, category] of cases) {
    const wrappers = [error, new Error('request failed', {cause: error})];
    if (!(error instanceof TypeError)) wrappers.push(Object.assign(new Error('transport wrapper', {cause: error}), {category: 'connection'}));
    for (const wrapped of wrappers) {
      const attempt = counted(() => wrapped);
      assert.equal(errorCategory(wrapped), category);
      assert.equal(isRetryable(wrapped), false);
      await assert.rejects(withRetry(attempt.run, {sleep: noSleep}), (caught) => caught === wrapped);
      assert.equal(attempt.calls(), 1);
    }
  }
});

test('rate limits and server errors are retryable', () => {
  assert.equal(isRetryable(statusError(429)), true);
  assert.equal(isRetryable(statusError(500)), true);
  assert.equal(isRetryable(statusError(503)), true);
});

test('a daily provider quota error is not retried', async () => {
  const quota = statusError(429, 'Rate limit exceeded (limit: 20 requests per day on Free Tier)');
  const attempt = counted(() => quota);

  assert.equal(isRetryable(quota), false);
  await assert.rejects(withRetry(attempt.run, {sleep: noSleep}), /requests per day/);
  assert.equal(attempt.calls(), 1);
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
  const retries: Array<[number, number]> = [];

  const value = await withRetry(attempt.run, {
    sleep: noSleep,
    onRetry: (next, total) => retries.push([next, total]),
  });

  assert.equal(value, 'ok');
  assert.equal(attempt.calls(), 3);
  assert.deepEqual(retries, [[2, 4], [3, 4]]);
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
    /aborted/i,
  );

  assert.equal(attempt.calls(), 1);
  assert.deepEqual(slept, [1_000]);
});

test('a signal already aborted stops before the first retry', async () => {
  const attempt = counted(() => statusError(500));

  await assert.rejects(
    withRetry(attempt.run, {signal: AbortSignal.abort(), sleep: noSleep}),
    /aborted/i,
  );

  assert.equal(attempt.calls(), 0);
});
