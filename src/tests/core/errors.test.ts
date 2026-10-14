import assert from 'node:assert/strict';
import test from 'node:test';
import {statusError} from '../fakes.js';
import {explainError} from '../../core/errors.js';

const DEEPSEEK_429 = 'DeepSeek request reached its RPM limit';

test('a rate limit names the provider instead of quoting the server', () => {
  const explained = explainError(statusError(429, DEEPSEEK_429), 'deepseek-flash');

  assert.match(explained.message, /^DeepSeek rate limit/);
  assert.match(explained.message, /DeepSeek V4.1 Flash/);
  assert.doesNotMatch(explained.message, /RPM/);
  assert.match(explained.hint!, /retry/);
  assert.match(explained.hint!, /DeepSeek limits/);
});

test('a daily quota error does not invent a reset time', () => {
  const explained = explainError(
    statusError(429, 'Rate limit exceeded (limit: 20 requests per day on Free Tier)'),
    'deepseek-flash',
  );

  assert.match(explained.message, /daily limit reached/);
  assert.match(explained.hint!, /provider/);
  assert.doesNotMatch(explained.hint!, /Pacific/);
});

test('an empty balance is told apart from a rate limit', () => {
  const paid = statusError(402, 'Insufficient Balance');
  const explained = explainError(paid, 'deepseek-flash');

  assert.match(explained.message, /DeepSeek refused the request/);
  assert.match(explained.message, /balance is empty/);
  assert.match(explained.hint!, /top up your DeepSeek account/);
});

test('an empty balance reported as a rate limit still reads as billing', () => {
  const quota = statusError(429, 'You exceeded your insufficient_quota');
  const explained = explainError(quota, 'deepseek-flash');

  assert.match(explained.message, /DeepSeek refused the request/);
});

test('a status carried by the cause is still recognised', () => {
  const wrapped = Object.assign(new Error('the stream ended early'), {
    cause: statusError(429, DEEPSEEK_429),
  });

  assert.match(explainError(wrapped, 'deepseek-flash').message, /DeepSeek rate limit/);
});

test('an error with no known shape is passed through untouched', () => {
  const explained = explainError(statusError(400, 'bad request'), 'deepseek-flash');

  assert.equal(explained.message, 'bad request');
  assert.equal(explained.hint, undefined);
});

test('an unknown model leaves the message alone', () => {
  const explained = explainError(statusError(429, DEEPSEEK_429), 'not-a-model');

  assert.equal(explained.message, DEEPSEEK_429);
  assert.equal(explained.hint, undefined);
});

test('an error with no message still says something', () => {
  assert.equal(
    explainError(new Error(''), 'deepseek-flash').message,
    'the request failed',
  );
});
