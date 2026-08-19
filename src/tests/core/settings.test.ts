import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {projectDir} from '../../core/projects.js';
import {
  loadSettings,
  modeFor,
  modeOf,
  rememberMode,
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

test('rulesOf is empty and modeOf is auto-edits before the settings are loaded', () => {
  assert.deepEqual(rulesOf(), {allow: [], ask: [], deny: []});
  assert.equal(modeOf(), 'auto-edits');
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


function settingsIn(home: string, user: unknown, project?: unknown): string[] {
  const files = [path.join(home, 'settings.json')];
  fs.writeFileSync(files[0], JSON.stringify(user));
  if (project !== undefined) {
    const directory = path.join(home, 'project', '.acc');
    fs.mkdirSync(directory, {recursive: true});
    files.push(path.join(directory, 'settings.json'));
    fs.writeFileSync(files[1], JSON.stringify(project));
  }
  return files;
}

function withHome(run: (home: string) => void): void {
  const previous = process.env.ACC_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-mode-'));
  process.env.ACC_HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = previous;
  }
}

function refused(files: string[]): SettingsError {
  try {
    loadSettings(files);
  } catch (error) {
    assert.ok(error instanceof SettingsError);
    return error;
  }
  throw new Error(`expected ${files.join(', ')} to be rejected`);
}

test('the permission mode is read from the user file', () => {
  for (const mode of ['read-only', 'ask-edits', 'auto-edits']) {
    withHome((home) => {
      loadSettings(settingsIn(home, {permission_mode: mode}));
      assert.equal(modeOf(), mode);
    });
  }
});

test('the permission mode is read beside the rules, not instead of them', () => {
  withHome((home) => {
    const rules = loadSettings(
      settingsIn(home, {
        permission_mode: 'read-only',
        permissions: {allow: ['bash(ls *)']},
      }),
    );
    assert.deepEqual(rules.allow, ['ls *']);
    assert.equal(modeOf(), 'read-only');
  });
});

test('the permission mode in a project file refuses to start', () => {
  withHome((home) => {
    const files = settingsIn(home, {}, {permission_mode: 'read-only'});
    const message = refused(files).message;
    assert.ok(message.includes(files[1]), message);
    assert.ok(message.includes('permission_mode'), message);
    assert.ok(message.includes(files[0]), message);
  });
});

test('an unknown permission mode refuses to start and lists the valid names', () => {
  withHome((home) => {
    const files = settingsIn(home, {permission_mode: 'approve_for_me'});
    const message = refused(files).message;
    assert.ok(message.includes(files[0]), message);
    for (const name of ['read-only', 'ask-edits', 'auto-edits']) {
      assert.ok(message.includes(name), message);
    }
  });
});

test('no permission mode anywhere leaves auto-edits', () => {
  withHome((home) => {
    loadSettings(settingsIn(home, {permissions: {allow: ['bash(ls *)']}}, {}));
    assert.equal(modeOf(), 'auto-edits');
  });
});

test('other unknown top-level keys are still ignored in every file', () => {
  withHome((home) => {
    loadSettings(
      settingsIn(home, {model: 'deepseek-v4-flash'}, {transcripts: true, hats: 3}),
    );
    assert.equal(modeOf(), 'auto-edits');
  });
});

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-work-'));
}

function projectFile(root: string, home: string, text: string): void {
  const dir = projectDir(root, home);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'project.json'), text);
}

test('a remembered mode wins over the user settings file', () => {
  withHome((home) => {
    loadSettings(settingsIn(home, {permission_mode: 'ask-edits'}));
    const root = workspace();

    rememberMode(root, 'read-only');

    assert.equal(modeFor(root), 'read-only');
    assert.equal(modeOf(), 'ask-edits');
  });
});

test('with nothing remembered the settings file decides, then auto-edits', () => {
  withHome((home) => {
    const root = workspace();
    loadSettings(settingsIn(home, {permission_mode: 'read-only'}));
    assert.equal(modeFor(root), 'read-only');

    loadSettings(settingsIn(home, {}));
    assert.equal(modeFor(root), 'auto-edits');
  });
});

test('an unusable project file is ignored, not an error', () => {
  withHome((home) => {
    loadSettings(settingsIn(home, {permission_mode: 'ask-edits'}));
    for (const text of ['{bad', '[]', '"read-only"', '{"permission_mode": "yolo"}']) {
      const root = workspace();
      projectFile(root, home, text);
      assert.equal(modeFor(root), 'ask-edits', text);
    }
  });
});

test('remembering a mode writes nothing outside the project folder', () => {
  withHome((home) => {
    const files = settingsIn(home, {permission_mode: 'ask-edits'});
    loadSettings(files);
    const before = fs.readFileSync(files[0]);
    const root = workspace();

    rememberMode(root, 'read-only');

    assert.deepEqual(fs.readFileSync(files[0]), before);
    assert.deepEqual(fs.readdirSync(home).sort(), ['projects', 'settings.json']);
    assert.deepEqual(fs.readdirSync(path.join(home, 'projects')), [
      path.basename(projectDir(root, home)),
    ]);
  });
});
