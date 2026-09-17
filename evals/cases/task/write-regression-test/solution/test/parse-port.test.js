import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePort} from '../src/parse-port.js';

test('parses a valid port', () => {
  assert.equal(parsePort('8080'), 8080);
});

test('rejects ports outside the allowed range', () => {
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('65536'), null);
});

test('rejects empty input', () => {
  assert.equal(parsePort(''), null);
});

test('rejects trailing non-digits from the reported input', () => {
  assert.equal(parsePort('8080oops'), null);
});
