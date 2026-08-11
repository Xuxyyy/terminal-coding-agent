import assert from 'node:assert/strict';
import test from 'node:test';
import {parseArgs} from './args.js';

test('parseArgs reads the workspace', () => {
  const options = parseArgs(['--workspace', process.cwd()]);

  assert.equal(options.workspaceRoot, process.cwd());
});

test('parseArgs rejects a task argument', () => {
  assert.throws(
    () => parseArgs(['--workspace', process.cwd(), 'fix', 'the', 'bug']),
    /unexpected argument: fix/,
  );
});

test('parseArgs rejects the removed sandbox opt-out', () => {
  assert.throws(
    () => parseArgs(['--workspace', process.cwd(), '--no-sandbox']),
    /unknown option/,
  );
});

test('parseArgs rejects unknown options', () => {
  assert.throws(
    () => parseArgs(['--workspace', process.cwd(), '--unknown']),
    /unknown option/,
  );
});

test('parseArgs rejects removed debug option', () => {
  assert.throws(
    () => parseArgs(['--workspace', process.cwd(), '--debug']),
    /unknown option: --debug/,
  );
});
