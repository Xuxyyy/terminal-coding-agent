import assert from 'node:assert/strict';
import test from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {parseArgs} from '../../ui/args.js';

test('parseArgs works on the current directory', () => {
  const options = parseArgs([], process.cwd());

  assert.equal(options.workspaceRoot, process.cwd());
});

test('parseArgs refuses to run in the home directory', () => {
  assert.throws(() => parseArgs([], os.homedir()), /home directory/);
});

test('parseArgs refuses to run in the filesystem root', () => {
  assert.throws(
    () => parseArgs([], path.parse(process.cwd()).root),
    /filesystem root/,
  );
});

test('parseArgs rejects the removed workspace option', () => {
  assert.throws(
    () => parseArgs(['--workspace', process.cwd()]),
    /--workspace was removed/,
  );
});

test('parseArgs rejects a task argument', () => {
  assert.throws(
    () => parseArgs(['fix', 'the', 'bug']),
    /unexpected argument: fix/,
  );
});

test('parseArgs rejects the removed sandbox opt-out', () => {
  assert.throws(() => parseArgs(['--no-sandbox']), /unknown option/);
});

test('parseArgs rejects unknown options', () => {
  assert.throws(() => parseArgs(['--unknown']), /unknown option/);
});

test('parseArgs rejects removed debug option', () => {
  assert.throws(() => parseArgs(['--debug']), /unknown option: --debug/);
});

test('parseArgs rejects the old session flags, now that /resume replaces them', () => {
  assert.throws(() => parseArgs(['--resume']), /unknown option: --resume/);
  assert.throws(
    () => parseArgs(['--resume', 'a1b2c3d4']),
    /unknown option: --resume/,
  );
  assert.throws(() => parseArgs(['--sessions']), /unknown option: --sessions/);
});
