import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  AgentDefinitionError,
  agentFiles,
  agentsDir,
  agentsOf,
  loadAgents,
  parseAgent,
} from '../../core/agents.js';

const FILE = '/tmp/explorer.md';

function definition(header: string, body = 'Inspect the repository carefully.'): string {
  return `---\n${header}\n---\n\n${body}\n`;
}

function refused(text: string, file = FILE): AgentDefinitionError {
  try {
    parseAgent(text, file);
  } catch (error) {
    assert.ok(error instanceof AgentDefinitionError);
    assert.ok(error.message.startsWith(file), error.message);
    return error;
  }
  throw new Error(`expected ${file} to be rejected`);
}

test('an absent directory has no agent files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-agents-'));

  assert.deepEqual(agentFiles(path.join(root, 'missing')), []);
});

test('discovery keeps only direct regular markdown files in sorted order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-agents-'));
  const directory = path.join(root, 'agents');
  fs.mkdirSync(path.join(directory, 'nested'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'zeta.md'), 'zeta');
  fs.writeFileSync(path.join(directory, 'alpha.md'), 'alpha');
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(directory, 'nested', 'hidden.md'), 'hidden');
  fs.symlinkSync(path.join(directory, 'alpha.md'), path.join(directory, 'linked.md'));

  assert.deepEqual(agentFiles(directory), [
    path.join(directory, 'alpha.md'),
    path.join(directory, 'zeta.md'),
  ]);
});

test('two definitions load in filename order and preserve every field and body', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-agents-'));
  const alpha = path.join(root, 'alpha.md');
  const zeta = path.join(root, 'zeta.md');
  fs.writeFileSync(
    zeta,
    definition(
      [
        'description: Makes focused edits',
        'model: glm-5.2',
        'tools:',
        '  - read_file',
        '  - edit_file',
        'permission_mode: auto-edits',
      ].join('\n'),
      'Edit only the requested files.\n\nReport the checks you ran.',
    ),
  );
  fs.writeFileSync(
    alpha,
    definition(
      [
        'description: Explores code safely',
        'model: deepseek-v4-flash',
        'tools:',
        '  - grep',
        'permission_mode: ask-edits',
      ].join('\n'),
      'Inspect the repository.\n\nReport exact file paths.',
    ),
  );

  assert.deepEqual(loadAgents([zeta, alpha]), [
    {
      name: 'alpha',
      description: 'Explores code safely',
      prompt: 'Inspect the repository.\n\nReport exact file paths.',
      model: 'deepseek-v4-flash',
      tools: ['grep'],
      permissionMode: 'ask-edits',
      file: alpha,
    },
    {
      name: 'zeta',
      description: 'Makes focused edits',
      prompt: 'Edit only the requested files.\n\nReport the checks you ran.',
      model: 'glm-5.2',
      tools: ['read_file', 'edit_file'],
      permissionMode: 'auto-edits',
      file: zeta,
    },
  ]);
});

test('the filename becomes the name and ACC_HOME moves the agents directory', () => {
  const previous = process.env.ACC_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-agents-home-'));
  process.env.ACC_HOME = home;
  try {
    const file = path.join(home, 'agents', 'code-reader_2.md');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, definition('description: Reads code'));

    assert.equal(agentsDir(), path.join(home, 'agents'));
    assert.deepEqual(agentFiles(), [file]);
    assert.equal(loadAgents()[0]?.name, 'code-reader_2');
  } finally {
    if (previous === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = previous;
  }
});

test('optional fields stay absent while an empty tools list stays present', () => {
  const minimal = parseAgent(definition('description: General helper'), '/tmp/minimal.md');
  const noTools = parseAgent(
    definition('description: Answers without tools\ntools: []'),
    '/tmp/no-tools.md',
  );

  assert.deepEqual(minimal, {
    name: 'minimal',
    description: 'General helper',
    prompt: 'Inspect the repository carefully.',
    file: '/tmp/minimal.md',
  });
  assert.deepEqual(noTools, {
    name: 'no-tools',
    description: 'Answers without tools',
    prompt: 'Inspect the repository carefully.',
    tools: [],
    file: '/tmp/no-tools.md',
  });
});

test('missing or malformed front matter names the source file', () => {
  for (const text of [
    'description: Missing delimiters',
    '---\ndescription: Missing closing delimiter\nBody',
    '---\ndescription: [broken\n---\nBody',
  ]) {
    assert.match(refused(text).message, /front matter|YAML|delimiter/i);
  }
});

test('front matter must be an object', () => {
  for (const header of ['', 'null', '[]', '- one\n- two', 'plain text']) {
    assert.match(refused(definition(header)).message, /object|front matter/i, header);
  }
});

test('unknown front matter keys are refused by name', () => {
  const error = refused(definition('description: Explorer\ntemperature: 0'));

  assert.match(error.message, /temperature/);
  assert.match(error.message, /unknown|no (?:key|field)|allowed/i);
});

test('description is required and must be a non-empty string', () => {
  for (const header of [
    'model: glm-5.2',
    'description:',
    'description: ""',
    'description: "   "',
    'description: 7',
  ]) {
    const error = refused(definition(header));
    assert.match(error.message, /description/);
    assert.match(error.message, /non-empty string|required/i);
  }
});

test('the markdown body must not be empty', () => {
  for (const body of ['', ' ', '\n\t\n']) {
    const error = refused(definition('description: Explorer', body));
    assert.match(error.message, /body|prompt/i);
    assert.match(error.message, /empty|required/i);
  }
});

test('invalid filenames are refused with the name and allowed characters', () => {
  for (const name of ['.md', '-explorer.md', '_explorer.md', 'Explorer.md', 'two words.md', 'a.b.md']) {
    const file = path.join('/tmp', name);
    const error = refused(definition('description: Explorer'), file);
    const invalidName = name.slice(0, -3);
    assert.ok(error.message.includes(JSON.stringify(invalidName)), error.message);
    assert.match(error.message, /lowercase|letters|digits|dashes|underscores/i);
  }
});

test('an unknown model is refused with the field and value', () => {
  const error = refused(definition('description: Explorer\nmodel: imaginary-v9'));

  assert.match(error.message, /model/);
  assert.match(error.message, /imaginary-v9/);
});

test('an invalid permission mode is refused with the field and value', () => {
  for (const value of ['approve-for-me', '7']) {
    const error = refused(definition(`description: Explorer\npermission_mode: ${value}`));
    assert.match(error.message, /permission_mode/);
    assert.ok(error.message.includes(value), error.message);
  }
});

test('tools must be an array of non-empty strings', () => {
  for (const tools of ['grep', '[grep, 7]', '[grep, ""]', '[grep, "   "]', '[grep, null]']) {
    const error = refused(definition(`description: Explorer\ntools: ${tools}`));
    assert.match(error.message, /tools/);
    assert.match(error.message, /array|non-empty string/i);
  }
});

test('duplicate tool names are refused by value', () => {
  const error = refused(definition('description: Explorer\ntools: [grep, read_file, grep]'));

  assert.match(error.message, /duplicate/i);
  assert.match(error.message, /grep/);
});

test('the agent tool is refused to prevent recursive children', () => {
  const error = refused(definition('description: Explorer\ntools: [grep, agent]'));

  assert.match(error.message, /agent/);
  assert.match(error.message, /recursive|recursion|cannot|must not/i);
});

test('a second load replaces the cache including with an empty input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-agents-'));
  const first = path.join(root, 'first.md');
  const second = path.join(root, 'second.md');
  fs.writeFileSync(first, definition('description: First agent'));
  fs.writeFileSync(second, definition('description: Second agent'));

  loadAgents([first]);
  assert.deepEqual(agentsOf().map(({name}) => name), ['first']);

  loadAgents([second]);
  assert.deepEqual(agentsOf().map(({name}) => name), ['second']);

  loadAgents([]);
  assert.deepEqual(agentsOf(), []);
});
