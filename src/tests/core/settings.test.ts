import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  loadSettings,
  parseSettings,
  rulesOf,
  SettingsError,
  settingsFiles,
} from '../../core/settings.js';

const FILE = '/tmp/settings.json';

function parse(value: unknown): ReturnType<typeof parseSettings> {
  return parseSettings(JSON.stringify(value), FILE);
}

function thrown(value: unknown): SettingsError {
  try {
    parse(value);
  } catch (error) {
    assert.ok(error instanceof SettingsError);
    return error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

test('rulesOf is empty before the settings are loaded', () => {
  assert.deepEqual(rulesOf(), {allow: [], ask: [], deny: []});
});

test('parseSettings reads the three lists with the tag stripped', () => {
  assert.deepEqual(
    parse({
      permissions: {
        deny: ['bash(curl *)'],
        ask: ['bash(npm run deploy*)'],
        allow: ['bash(npm run *)', 'bash(python3 scripts/*)'],
      },
    }),
    {
      allow: ['npm run *', 'python3 scripts/*'],
      ask: ['npm run deploy*'],
      deny: ['curl *'],
    },
  );
});

test('parseSettings treats missing lists and missing permissions as no rules', () => {
  const empty = {allow: [], ask: [], deny: []};
  assert.deepEqual(parse({}), empty);
  assert.deepEqual(parse({permissions: {}}), empty);
  assert.deepEqual(parse({permissions: {allow: []}}), empty);
});

test('parseSettings ignores top-level keys it does not implement', () => {
  assert.deepEqual(
    parse({
      model: 'deepseek-v4-flash',
      permission_mode: 'approve_for_me',
      transcripts: true,
      permissions: {allow: ['bash(ls *)']},
    }),
    {allow: ['ls *'], ask: [], deny: []},
  );
});

test('parseSettings names the file when the JSON is broken', () => {
  let error: unknown;
  try {
    parseSettings('{bad', FILE);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SettingsError);
  assert.match(error.message, /settings\.json/);
});

test('parseSettings rejects any tag but bash and names it', () => {
  for (const rule of ['write(x)', 'Bash(x)', 'npm run *', 'edit(src/a.ts)']) {
    const error = thrown({permissions: {allow: [rule]}});
    assert.match(error.message, /bash/, rule);
    assert.match(error.message, /settings\.json/, rule);
  }
});

test('parseSettings rejects a rule that is not a string', () => {
  assert.match(thrown({permissions: {allow: [7]}}).message, /must be a string/);
});

test('parseSettings rejects an unknown key inside permissions', () => {
  assert.match(
    thrown({permissions: {allowed: ['bash(ls)']}}).message,
    /"permissions" has no key "allowed"/,
  );
});

test('parseSettings rejects a root or a permissions value that is not an object', () => {
  assert.match(thrown([]).message, /must hold a JSON object/);
  assert.match(thrown('text').message, /must hold a JSON object/);
  assert.match(thrown({permissions: []}).message, /must be an object/);
  assert.match(thrown({permissions: {allow: 'bash(ls)'}}).message, /must be an array/);
});

test('loadSettings concatenates the files in order and skips a missing one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-settings-'));
  const home = path.join(directory, 'home.json');
  const workspace = path.join(directory, 'workspace.json');
  fs.writeFileSync(home, JSON.stringify({permissions: {allow: ['bash(ls *)']}}));
  fs.writeFileSync(
    workspace,
    JSON.stringify({permissions: {allow: ['bash(npm run *)'], deny: ['bash(curl *)']}}),
  );

  const rules = loadSettings([home, path.join(directory, 'missing.json'), workspace]);

  assert.deepEqual(rules, {
    allow: ['ls *', 'npm run *'],
    ask: [],
    deny: ['curl *'],
  });
  assert.deepEqual(rulesOf(), rules);
});

test('loadSettings refuses to continue when one file is broken', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-settings-'));
  const broken = path.join(directory, 'settings.json');
  fs.writeFileSync(broken, '{bad');

  assert.throws(() => loadSettings([broken]), SettingsError);
});

test('settingsFiles looks in the acc home and then the workspace', () => {
  const previous = process.env.ACC_HOME;
  process.env.ACC_HOME = '/tmp/acc-home';
  try {
    assert.deepEqual(settingsFiles('/tmp/project'), [
      '/tmp/acc-home/settings.json',
      '/tmp/project/.acc/settings.json',
    ]);
  } finally {
    if (previous === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = previous;
  }
});
