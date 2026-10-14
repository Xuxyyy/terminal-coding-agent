import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {chooseModel, DEFAULT_MODEL} from '../../core/client.js';
import {loadEnvFiles, parseEnv} from '../../core/env.js';
import {MODEL_IDS, PROVIDERS} from '../../core/models.js';

test('DeepSeek Flash is the only coding model', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['deepseek']);
  assert.deepEqual(MODEL_IDS, ['deepseek-flash']);
});

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
  assert.equal(DEFAULT_MODEL, 'deepseek-flash');
});

test('chooseModel uses the default even without a key', () => {
  assert.equal(chooseModel({}), 'deepseek-flash');
});

test('chooseModel obeys an explicit ACC_MODEL', () => {
  assert.equal(
    chooseModel({ACC_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'k'}),
    'deepseek-flash',
  );
});

test('chooseModel names the default when nothing is configured', () => {
  assert.equal(chooseModel({}), DEFAULT_MODEL);
});

test('chooseModel takes the saved model when the environment names none', () => {
  assert.equal(chooseModel({}, 'deepseek-flash'), 'deepseek-flash');
});

test('an explicit ACC_MODEL beats a saved model', () => {
  assert.equal(chooseModel({ACC_MODEL: 'deepseek-flash'}, 'deepseek-flash'), 'deepseek-flash');
});

test('a saved model beats the key scan', () => {
  assert.equal(chooseModel({DEEPSEEK_API_KEY: 'k'}, 'deepseek-flash'), 'deepseek-flash');
});
