import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {chooseModel, DEFAULT_MODEL} from './client.js';
import {loadEnvFiles, parseEnv} from './env.js';

test('parseEnv reads plain, quoted, and exported lines', () => {
  const values = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=abc123',
      'QUOTED="with spaces"',
      "SINGLE='single'",
      'export EXPORTED=xyz',
      '  SPACED = padded ',
    ].join('\n'),
  );

  assert.deepEqual(values, {
    PLAIN: 'abc123',
    QUOTED: 'with spaces',
    SINGLE: 'single',
    EXPORTED: 'xyz',
    SPACED: 'padded',
  });
});

test('parseEnv keeps an equals sign inside a value', () => {
  assert.deepEqual(parseEnv('URL=https://a.com/?x=1'), {
    URL: 'https://a.com/?x=1',
  });
});

test('parseEnv ignores lines that are not assignments', () => {
  assert.deepEqual(parseEnv('just words\n=novalue\n1BAD=x\n'), {});
});

test('loadEnvFiles fills gaps without overriding the real environment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-env-'));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'CODING_CLI_SET=from-file\nCODING_CLI_KEPT=from-file\n');
  process.env.CODING_CLI_KEPT = 'from-shell';
  delete process.env.CODING_CLI_SET;

  loadEnvFiles([file, path.join(directory, 'missing.env')]);

  assert.equal(process.env.CODING_CLI_SET, 'from-file');
  assert.equal(process.env.CODING_CLI_KEPT, 'from-shell');
});

test('chooseModel prefers the default model when its key is present', () => {
  assert.equal(chooseModel({DEEPSEEK_API_KEY: 'k'}), DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'deepseek-v4-flash');
});

test('chooseModel falls back to a model whose key is set', () => {
  assert.equal(chooseModel({MOONSHOT_API_KEY: 'k'}), 'kimi-k3');
});

test('chooseModel obeys an explicit ACC_MODEL', () => {
  assert.equal(
    chooseModel({ACC_MODEL: 'glm-5.2', DEEPSEEK_API_KEY: 'k'}),
    'glm-5.2',
  );
});

test('chooseModel names the default when nothing is configured', () => {
  assert.equal(chooseModel({}), DEFAULT_MODEL);
});
