import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  loadSettings,
  parseServers,
  serversOf,
  SettingsError,
  userSettingsFile,
  type StdioServer,
} from '../../core/settings.js';

const FILE = '/tmp/settings.json';

function parse(
  value: unknown,
  environment: NodeJS.ProcessEnv = {},
): Record<string, StdioServer> {
  return parseServers(JSON.stringify(value), FILE, true, environment);
}

function server(fields: Partial<StdioServer> & {command: string}): StdioServer {
  return {args: [], env: {}, enabled: true, tools: null, ...fields};
}

function thrown(value: unknown, environment: NodeJS.ProcessEnv = {}): SettingsError {
  try {
    parse(value, environment);
  } catch (error) {
    assert.ok(error instanceof SettingsError);
    return error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

test('parseServers reads one server and defaults its args and env to empty', () => {
  assert.deepEqual(parse({mcpServers: {files: {command: 'mcp-files'}}}), {
    files: server({command: 'mcp-files'}),
  });
});

test('parseServers keeps the args and the env that are written', () => {
  assert.deepEqual(
    parse({
      mcpServers: {
        files: {command: 'npx', args: ['-y', 'mcp-files'], env: {ROOT: '/srv'}},
      },
    }),
    {files: server({command: 'npx', args: ['-y', 'mcp-files'], env: {ROOT: '/srv'}})},
  );
});

test('mcpServers in a project file is refused and names the user settings file', () => {
  let error: unknown;
  try {
    parseServers(JSON.stringify({mcpServers: {}}), FILE, false, {});
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SettingsError);
  assert.ok(error.message.includes(FILE), error.message);
  assert.ok(error.message.includes('"mcpServers"'), error.message);
  assert.ok(error.message.includes(userSettingsFile()), error.message);
});

test('no mcpServers key is no servers', () => {
  assert.deepEqual(parse({}), {});
  assert.deepEqual(parse({permissions: {allow: ['bash(ls *)']}}), {});
  assert.deepEqual(parse({mcpServers: {}}), {});
});

test('parseServers names the file when a value has the wrong shape', () => {
  for (const value of [
    {mcpServers: []},
    {mcpServers: {files: 'mcp-files'}},
    {mcpServers: {files: {command: 'npx', args: [7]}}},
  ]) {
    assert.ok(thrown(value).message.includes(FILE), JSON.stringify(value));
  }
});

test('parseServers rejects a command that is missing or empty', () => {
  assert.match(thrown({mcpServers: {files: {}}}).message, /must be a non-empty string/);
  assert.match(
    thrown({mcpServers: {files: {command: '  '}}}).message,
    /must be a non-empty string/,
  );
});

test('a server name with a dot, a space, or nothing in it is refused', () => {
  for (const name of ['a.b', 'a b', '']) {
    const error = thrown({mcpServers: {[name]: {command: 'mcp-files'}}});
    assert.match(error.message, /letters, digits, dashes and underscores only/, name);
    assert.ok(error.message.includes(JSON.stringify(name)), error.message);
  }
});

test('a server name of letters, digits, dashes and underscores is accepted', () => {
  assert.deepEqual(parse({mcpServers: {'note-taker_1': {command: 'notes'}}}), {
    'note-taker_1': server({command: 'notes'}),
  });
});

test('a variable in an env value is expanded from the environment passed in', () => {
  assert.deepEqual(
    parse({mcpServers: {gh: {command: 'gh-mcp', env: {KEY: 'Bearer ${TOKEN}'}}}}, {
      TOKEN: 'secret',
    }),
    {gh: server({command: 'gh-mcp', env: {KEY: 'Bearer secret'}})},
  );
});

test('a variable in an args entry is expanded from the environment passed in', () => {
  assert.deepEqual(
    parse({mcpServers: {files: {command: 'npx', args: ['--root=${ROOT}']}}}, {
      ROOT: '/srv',
    }),
    {files: server({command: 'npx', args: ['--root=/srv']})},
  );
});

test('a variable that is not set in the environment is refused by name', () => {
  for (const value of [
    {mcpServers: {gh: {command: 'gh-mcp', env: {KEY: '${TOKEN}'}}}},
    {mcpServers: {gh: {command: 'gh-mcp', args: ['${TOKEN}']}}},
  ]) {
    const error = thrown(value, {OTHER: 'set'});
    assert.ok(error.message.includes('TOKEN'), error.message);
    assert.ok(error.message.includes(FILE), error.message);
  }
});

test('parseServers rejects an unknown key inside a server', () => {
  const error = thrown({mcpServers: {files: {command: 'npx', cwd: '/srv'}}});
  assert.match(error.message, /"mcpServers\.files" has no key "cwd"/);
  assert.match(error.message, /command, args, env, enabled/);
});

test('a server with no enabled key is enabled', () => {
  assert.deepEqual(parse({mcpServers: {files: {command: 'npx'}}}), {
    files: server({command: 'npx', enabled: true}),
  });
});

test('enabled false parses as disabled and keeps the rest of the server', () => {
  assert.deepEqual(
    parse({mcpServers: {files: {command: 'npx', args: ['-y'], enabled: false}}}),
    {files: server({command: 'npx', args: ['-y'], enabled: false})},
  );
});

test('an enabled that is not a boolean is a startup error naming the server', () => {
  for (const value of ['no', 0, null, []]) {
    const error = thrown({mcpServers: {files: {command: 'npx', enabled: value}}});
    assert.match(error.message, /"mcpServers\.files"\.enabled must be true or false/);
    assert.ok(error.message.includes(FILE), error.message);
  }
});

test('a server with no tools key publishes everything', () => {
  assert.deepEqual(parse({mcpServers: {gh: {command: 'gh-mcp'}}}), {
    gh: server({command: 'gh-mcp', tools: null}),
  });
});

test('a tools allowlist is kept as written', () => {
  assert.deepEqual(
    parse({mcpServers: {gh: {command: 'gh-mcp', tools: ['list_*', 'get_file']}}}),
    {gh: server({command: 'gh-mcp', tools: ['list_*', 'get_file']})},
  );
});

test('an empty tools allowlist publishes nothing and is not an error', () => {
  assert.deepEqual(parse({mcpServers: {gh: {command: 'gh-mcp', tools: []}}}), {
    gh: server({command: 'gh-mcp', tools: []}),
  });
});

test('a bare string instead of an array of tools is a startup error', () => {
  const error = thrown({mcpServers: {gh: {command: 'gh-mcp', tools: 'list_*'}}});
  assert.match(error.message, /"mcpServers\.gh"\.tools must be an array/);
  assert.ok(error.message.includes(FILE), error.message);
});

test('an entry in tools that is not a non-empty string is refused by name', () => {
  for (const value of [7, null, '', '  ', ['list_*']]) {
    const error = thrown({mcpServers: {gh: {command: 'gh-mcp', tools: [value]}}});
    assert.match(
      error.message,
      /every entry in "mcpServers\.gh"\.tools must be a non-empty string/,
    );
    assert.ok(error.message.includes(FILE), error.message);
  }
});

test('a variable inside a tools pattern is left literal, not expanded', () => {
  assert.deepEqual(
    parse({mcpServers: {gh: {command: 'gh-mcp', tools: ['${TOOL}_*']}}}, {
      TOOL: 'list',
    }),
    {gh: server({command: 'gh-mcp', tools: ['${TOOL}_*']})},
  );
});

test('serversOf is empty until the settings are loaded and then holds them', () => {
  assert.deepEqual(serversOf(), {});

  const previous = process.env.ACC_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-mcp-'));
  process.env.ACC_HOME = home;
  try {
    const file = path.join(home, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({mcpServers: {files: {command: 'npx'}}}));

    loadSettings([file]);

    assert.deepEqual(serversOf(), {files: server({command: 'npx'})});
  } finally {
    if (previous === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = previous;
  }
});
