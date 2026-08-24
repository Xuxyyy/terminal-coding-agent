import assert from 'node:assert/strict';
import test from 'node:test';
import {statusError} from '../fakes.js';
import {explainError} from '../../core/errors.js';

const MOONSHOT_429 =
  'Your account org-fb80b315a9504b06981ee24703754985<ak-fbkcufkjncr111cco6bi> ' +
  'request reached organization max RPM: 3, please try again after 1 seconds';

test('a rate limit names the provider instead of quoting the server', () => {
  const explained = explainError(statusError(429, MOONSHOT_429), 'kimi-k3');

  assert.match(explained.message, /^Moonshot rate limit/);
  assert.match(explained.message, /Kimi K3/);
  assert.doesNotMatch(explained.message, /RPM/);
  assert.match(explained.hint!, /\/model/);
  assert.match(explained.hint!, /Moonshot plan/);
});

test('an empty balance is told apart from a rate limit', () => {
  const paid = statusError(402, 'Insufficient Balance');
  const explained = explainError(paid, 'deepseek-v4-flash');

  assert.match(explained.message, /DeepSeek refused the request/);
  assert.match(explained.message, /balance is empty/);
  assert.match(explained.hint!, /top up your DeepSeek account/);
});

test('an empty balance reported as a rate limit still reads as billing', () => {
  const quota = statusError(429, 'You exceeded your insufficient_quota');
  const explained = explainError(quota, 'glm-5.2');

  assert.match(explained.message, /Z\.ai refused the request/);
});

test('a status carried by the cause is still recognised', () => {
  const wrapped = Object.assign(new Error('the stream ended early'), {
    cause: statusError(429, MOONSHOT_429),
  });

  assert.match(explainError(wrapped, 'kimi-k3').message, /Moonshot rate limit/);
});

test('an error with no known shape is passed through untouched', () => {
  const explained = explainError(statusError(400, 'bad request'), 'kimi-k3');

  assert.equal(explained.message, 'bad request');
  assert.equal(explained.hint, undefined);
});

test('an unknown model leaves the message alone', () => {
  const explained = explainError(statusError(429, MOONSHOT_429), 'not-a-model');

  assert.equal(explained.message, MOONSHOT_429);
  assert.equal(explained.hint, undefined);
});

test('an error with no message still says something', () => {
  assert.equal(
    explainError(new Error(''), 'kimi-k3').message,
    'the request failed',
  );
});
