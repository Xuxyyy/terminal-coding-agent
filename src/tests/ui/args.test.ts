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

test('parseArgs reads the task after -p into print', () => {
  assert.deepEqual(parseArgs(['-p', 'fix the bug'], process.cwd()), {
    workspaceRoot: process.cwd(),
    print: 'fix the bug',
    json: false,
    yes: false,
    maxSeconds: 300,
  });
});

test('parseArgs reads the task after --print the same way', () => {
  assert.deepEqual(
    parseArgs(['--print', 'fix the bug'], process.cwd()),
    parseArgs(['-p', 'fix the bug'], process.cwd()),
  );
});

test('parseArgs rejects a print flag with nothing after it', () => {
  assert.throws(
    () => parseArgs(['--print'], process.cwd()),
    /--print needs a value/,
  );
  assert.throws(() => parseArgs(['-p'], process.cwd()), /-p needs a value/);
});

test('parseArgs rejects --json outside print mode', () => {
  assert.throws(
    () => parseArgs(['--json'], process.cwd()),
    /--json only applies to print mode/,
  );
});

test('parseArgs rejects --yes outside print mode', () => {
  assert.throws(
    () => parseArgs(['--yes'], process.cwd()),
    /--yes only applies to print mode/,
  );
});

test('parseArgs rejects a --max-seconds value that is not a number', () => {
  assert.throws(
    () => parseArgs(['-p', 'hi', '--max-seconds', 'abc'], process.cwd()),
    /--max-seconds needs a positive number, got: abc/,
  );
});

test('parseArgs rejects a --max-seconds value that is not positive', () => {
  assert.throws(
    () => parseArgs(['-p', 'hi', '--max-seconds', '0'], process.cwd()),
    /--max-seconds needs a positive number, got: 0/,
  );
  assert.throws(
    () => parseArgs(['-p', 'hi', '--max-seconds', '-5'], process.cwd()),
    /--max-seconds needs a positive number, got: -5/,
  );
});

test('parseArgs takes the given --max-seconds in print mode', () => {
  const options = parseArgs(
    ['-p', 'hi', '--max-seconds', '60'],
    process.cwd(),
  );

  assert.equal(options.maxSeconds, 60);
});

test('parseArgs falls back to five minutes when --max-seconds is absent', () => {
  const options = parseArgs(['-p', 'hi'], process.cwd());

  assert.equal(options.maxSeconds, 300);
});

test('parseArgs defaults every print field when no flags are given', () => {
  assert.deepEqual(parseArgs([], process.cwd()), {
    workspaceRoot: process.cwd(),
    print: null,
    json: false,
    yes: false,
    maxSeconds: 300,
  });
});

test('parseArgs still refuses the home directory in print mode', () => {
  assert.throws(() => parseArgs(['-p', 'hi'], os.homedir()), /home directory/);
});

test('parseArgs takes -p, --json and --yes together', () => {
  const options = parseArgs(
    ['-p', 'ship it', '--json', '--yes'],
    process.cwd(),
  );

  assert.deepEqual(options, {
    workspaceRoot: process.cwd(),
    print: 'ship it',
    json: true,
    yes: true,
    maxSeconds: 300,
  });
});
