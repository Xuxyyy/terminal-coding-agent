import assert from 'node:assert/strict';
import test from 'node:test';
import {statusError} from '../fakes.js';
import {explainError} from '../../core/errors.js';

const GEMINI_429 = 'Gemini request reached its RPM limit';

test('a rate limit names the provider instead of quoting the server', () => {
  const explained = explainError(statusError(429, GEMINI_429), 'gemini-3.8-flash');

  assert.match(explained.message, /^Gemini rate limit/);
  assert.match(explained.message, /Gemini 3.8 Flash/);
  assert.doesNotMatch(explained.message, /RPM/);
  assert.match(explained.hint!, /\/model/);
  assert.match(explained.hint!, /Gemini plan/);
});

test('a daily quota error gives the reset time', () => {
  const explained = explainError(
    statusError(429, 'Rate limit exceeded (limit: 20 requests per day on Free Tier)'),
    'gemini-3.8-flash',
  );

  assert.match(explained.message, /daily limit reached/);
  assert.match(explained.hint!, /midnight Pacific/);
});

test('an empty balance is told apart from a rate limit', () => {
  const paid = statusError(402, 'Insufficient Balance');
  const explained = explainError(paid, 'gemini-3.8-flash');

  assert.match(explained.message, /Gemini refused the request/);
  assert.match(explained.message, /balance is empty/);
  assert.match(explained.hint!, /top up your Gemini account/);
});

test('an empty balance reported as a rate limit still reads as billing', () => {
  const quota = statusError(429, 'You exceeded your insufficient_quota');
  const explained = explainError(quota, 'gemini-3.8-flash');

  assert.match(explained.message, /Gemini refused the request/);
});

test('a status carried by the cause is still recognised', () => {
  const wrapped = Object.assign(new Error('the stream ended early'), {
    cause: statusError(429, GEMINI_429),
  });

  assert.match(explainError(wrapped, 'gemini-3.8-flash').message, /Gemini rate limit/);
});

test('an error with no known shape is passed through untouched', () => {
  const explained = explainError(statusError(400, 'bad request'), 'gemini-3.8-flash');

  assert.equal(explained.message, 'bad request');
  assert.equal(explained.hint, undefined);
});

test('an unknown model leaves the message alone', () => {
  const explained = explainError(statusError(429, GEMINI_429), 'not-a-model');

  assert.equal(explained.message, GEMINI_429);
  assert.equal(explained.hint, undefined);
});

test('an error with no message still says something', () => {
  assert.equal(
    explainError(new Error(''), 'gemini-3.8-flash').message,
    'the request failed',
  );
});
