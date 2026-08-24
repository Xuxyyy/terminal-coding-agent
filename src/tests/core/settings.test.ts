import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {MODEL_IDS} from '../../core/models.js';
import {
  loadSettings,
  modeOf,
  modelOf,
  rememberMode,
  rememberModel,
  parseSettings,
  rulesOf,
  SettingsError,
  settingsFiles,
  type Rule,
} from '../../core/settings.js';

const FILE = '/tmp/settings.json';

function bash(...patterns: string[]): Rule[] {
  return patterns.map((pattern) => ({tag: 'bash', pattern}));
}

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

test('parseSettings reads the three lists with the tag kept', () => {
  assert.deepEqual(
    parse({
      permissions: {
        deny: ['bash(curl *)'],
        ask: ['bash(npm run deploy*)'],
        allow: ['bash(npm run *)', 'edit(plans/**)'],
      },
    }),
    {
      allow: [
        {tag: 'bash', pattern: 'npm run *'},
        {tag: 'edit', pattern: 'plans/**'},
      ],
      ask: bash('npm run deploy*'),
      deny: bash('curl *'),
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
    {allow: bash('ls *'), ask: [], deny: []},
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

test('parseSettings rejects an unknown tag and lists both valid ones', () => {
  for (const rule of ['read(src/**)', 'Bash(x)', 'npm run *']) {
    const error = thrown({permissions: {allow: [rule]}});
    assert.match(error.message, /bash\(<pattern>\)/, rule);
    assert.match(error.message, /edit\(<pattern>\)/, rule);
    assert.match(error.message, /settings\.json/, rule);
  }
});

test('parseSettings refuses a write rule and says edit covers both tools', () => {
  const error = thrown({permissions: {allow: ['write(src/**)']}});
  assert.match(error.message, /edit\(<pattern>\) covers both edit_file and write_file/);
  assert.match(error.message, /settings\.json/);
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
    allow: bash('ls *', 'npm run *'),
    ask: [],
    deny: bash('curl *'),
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
  for (const mode of ['ask-edits', 'auto-edits', 'auto']) {
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
        permission_mode: 'ask-edits',
        permissions: {allow: ['bash(ls *)']},
      }),
    );
    assert.deepEqual(rules.allow, bash('ls *'));
    assert.equal(modeOf(), 'ask-edits');
  });
});

test('the permission mode in a project file refuses to start', () => {
  withHome((home) => {
    const files = settingsIn(home, {}, {permission_mode: 'ask-edits'});
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
    for (const name of ['ask-edits', 'auto-edits', 'auto']) {
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

test('remembering a mode writes it into the user settings file', () => {
  withHome((home) => {
    const files = settingsIn(home, {permission_mode: 'auto-edits'});
    loadSettings(files);

    rememberMode('ask-edits');

    assert.equal(modeOf(), 'ask-edits');
    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), {
      permission_mode: 'ask-edits',
    });
  });
});

test('a remembered mode is what the next run reads', () => {
  withHome((home) => {
    const files = settingsIn(home, {});
    loadSettings(files);

    rememberMode('ask-edits');
    loadSettings(files);

    assert.equal(modeOf(), 'ask-edits');
  });
});

test('remembering a mode keeps every other setting', () => {
  withHome((home) => {
    const files = settingsIn(home, {
      model: 'deepseek-v4-flash',
      permissions: {allow: ['bash(npm run *)']},
    });
    loadSettings(files);

    rememberMode('ask-edits');
    const rules = loadSettings(files);

    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), {
      model: 'deepseek-v4-flash',
      permissions: {allow: ['bash(npm run *)']},
      permission_mode: 'ask-edits',
    });
    assert.deepEqual(rules.allow, bash('npm run *'));
  });
});

test('remembering a mode with no settings file yet writes one', () => {
  withHome((home) => {
    loadSettings([]);
    const file = path.join(home, 'settings.json');

    rememberMode('ask-edits');

    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      permission_mode: 'ask-edits',
    });
    assert.deepEqual(fs.readdirSync(home), ['settings.json']);
  });
});

test('a saved model round-trips through remembering and loading again', () => {
  withHome((home) => {
    const files = settingsIn(home, {});
    loadSettings(files);
    assert.equal(modelOf(), null);

    rememberModel('glm-5.2');
    assert.equal(modelOf(), 'glm-5.2');

    loadSettings(files);
    assert.equal(modelOf(), 'glm-5.2');
  });
});

test('an unknown model refuses to start and lists the valid ids', () => {
  withHome((home) => {
    const files = settingsIn(home, {model: 'gpt-9'});
    const message = refused(files).message;

    assert.ok(message.includes('gpt-9'), message);
    for (const id of MODEL_IDS) assert.ok(message.includes(id), message);
  });
});

test('a model in a project file refuses to start and names the user file', () => {
  withHome((home) => {
    const files = settingsIn(home, {}, {model: 'glm-5.2'});
    const message = refused(files).message;

    assert.ok(message.includes('"model"'), message);
    assert.ok(message.includes(path.join(home, 'settings.json')), message);
  });
});

test('remembering a model keeps every other setting', () => {
  withHome((home) => {
    const files = settingsIn(home, {
      permission_mode: 'ask-edits',
      permissions: {allow: ['bash(npm run *)']},
    });
    loadSettings(files);

    rememberModel('kimi-k3');

    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), {
      permission_mode: 'ask-edits',
      permissions: {allow: ['bash(npm run *)']},
      model: 'kimi-k3',
    });
    assert.equal(modeOf(), 'ask-edits');
  });
});

test('a settings file that stopped parsing is refused, not erased', () => {
  withHome((home) => {
    const file = path.join(home, 'settings.json');
    fs.writeFileSync(file, '{bad');

    assert.throws(() => rememberMode('ask-edits'), SettingsError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  });
});
