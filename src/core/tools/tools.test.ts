import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {z} from 'zod';
import type {ConfirmDecision, ConfirmRequest, Host} from '../host.js';
import {approvalKey, decide} from '../policy.js';
import {bash} from './bash.js';
import {editFile} from './edit.js';
import {readFile} from './read.js';
import {runTool, toolDefinitions, type Tool, type ToolContext} from './registry.js';
import {writeFile} from './write.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-'));
}

function hostThatAnswers(...answers: ConfirmDecision[]) {
  const asked: ConfirmRequest[] = [];
  const host: Host = {
    signal: new AbortController().signal,
    onEvent() {},
    async confirm(request) {
      asked.push(request);
      return answers[asked.length - 1] ?? answers[answers.length - 1] ?? 'once';
    },
  };
  return {host, asked};
}

function context(root: string, host: Host): ToolContext {
  return {root, host, allowed: new Set<string>()};
}

const fakeBash: Tool = {
  name: 'bash',
  description: 'fake',
  schema: z.object({command: z.string()}),
  confirm(args) {
    return {
      command: (args as {command: string}).command,
      reason: 'test',
      suppressible: true,
    };
  },
  async run() {
    return {text: '[exit 0]\nran'};
  },
};

const registry = [readFile, editFile, writeFile, fakeBash];

test('decide asks only for bash', () => {
  assert.equal(decide('bash'), 'ask');
  assert.equal(decide('read_file'), 'allow');
  assert.equal(decide('write_file'), 'allow');
  assert.equal(decide('edit_file'), 'allow');
});

test('approvalKey uses the first word of the command', () => {
  assert.equal(approvalKey('  npm test --silent '), 'npm');
  assert.equal(approvalKey('git push origin main'), 'git');
});

test('broken JSON arguments come back as a tool error, not a throw', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    '{"path": "a.ts"',
    context(root, host),
  );

  assert.match(output.text, /^Error: the arguments were not valid JSON/);
});

test('arguments that fail the schema come back as a tool error', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(registry, 'read_file', '{}', context(root, host));

  assert.match(output.text, /^Error: invalid arguments: path/);
});

test('an unknown tool name is reported to the model', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(registry, 'search', '{}', context(root, host));

  assert.equal(output.text, "Error: unknown tool 'search'");
});

test('edit_file refuses a string that is not in the file', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: 'a.ts', old_string: 'const b', new_string: 'const c'}),
    context(root, host),
  );

  assert.equal(output.text, 'Error: old_string not found in a.ts');
});

test('edit_file refuses a string that appears more than once', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'x = 1\nx = 1\n');
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2'}),
    context(root, host),
  );

  assert.match(output.text, /^Error: old_string appears 2 times in a\.ts/);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'x = 1\nx = 1\n');
});

test('edit_file replaces a unique match and returns a diff', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'a = 1\nb = 2\nc = 3\n');
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: 'a.ts', old_string: 'b = 2', new_string: 'b = 20'}),
    context(root, host),
  );

  assert.equal(output.text, "Edited 'a.ts'.");
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'a = 1\nb = 20\nc = 3\n');
  assert.equal(output.diff?.added, 1);
  assert.equal(output.diff?.removed, 1);
  assert.equal(output.diff?.path, 'a.ts');
});

test('a path outside the workspace is rejected', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    JSON.stringify({path: '../../etc/passwd'}),
    context(root, host),
  );

  assert.equal(
    output.text,
    'Error: path is outside the workspace: ../../etc/passwd',
  );
});

test('an absolute path outside the workspace is rejected', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: '/etc/passwd', content: 'x'}),
    context(root, host),
  );

  assert.match(output.text, /^Error: path is outside the workspace/);
  assert.ok(!fs.existsSync(path.join(root, 'etc')));
});

test('write_file reports the size and a diff against the old contents', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'old\n');
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: 'a.ts', content: 'new\n'}),
    context(root, host),
  );

  assert.equal(output.text, "Wrote 4 chars to 'a.ts'.");
  assert.equal(output.diff?.added, 1);
  assert.equal(output.diff?.removed, 1);
});

test('read_file numbers the lines and notes a partial read', async () => {
  const root = workspace();
  const lines = Array.from({length: 10}, (_, i) => `line ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(root, 'a.ts'), `${lines}\n`);
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    JSON.stringify({path: 'a.ts', offset: 2, limit: 3}),
    context(root, host),
  );

  assert.match(output.text, /2\tline 2/);
  assert.match(output.text, /\[file has 10 lines; showing 2-4\.\]$/);
});

test('an edit never asks the user', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'a = 1\n');
  const {host, asked} = hostThatAnswers('deny');
  await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: 'a.ts', old_string: 'a = 1', new_string: 'a = 2'}),
    context(root, host),
  );

  assert.equal(asked.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'a = 2\n');
});

test('bash asks before running and reports a denial as a tool error', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('deny');
  const output = await runTool(
    registry,
    'bash',
    JSON.stringify({command: 'rm -rf /'}),
    context(root, host),
  );

  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.command, 'rm -rf /');
  assert.equal(
    output.text,
    'Error: user denied this command; try another approach',
  );
});

test('approving for the session covers the same command word only', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('session');
  const ctx = context(root, host);

  await runTool(registry, 'bash', JSON.stringify({command: 'npm test'}), ctx);
  assert.equal(asked.length, 1);

  await runTool(registry, 'bash', JSON.stringify({command: 'npm run build'}), ctx);
  assert.equal(asked.length, 1);

  await runTool(registry, 'bash', JSON.stringify({command: 'git push'}), ctx);
  assert.equal(asked.length, 2);
  assert.equal(asked[1]?.command, 'git push');
});

test('approving once does not cover the next call', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const ctx = context(root, host);

  await runTool(registry, 'bash', JSON.stringify({command: 'npm test'}), ctx);
  await runTool(registry, 'bash', JSON.stringify({command: 'npm test'}), ctx);

  assert.equal(asked.length, 2);
});

test('bash runs a real command and reports its exit code', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    [bash],
    'bash',
    JSON.stringify({command: 'echo hi && exit 3'}),
    context(root, host),
  );

  assert.match(output.text, /^\[exit 3\]\nhi/);
});

test('tool definitions carry a JSON schema the model can fill in', () => {
  const definitions = toolDefinitions([readFile, bash]);
  const read = definitions[0]?.function;

  assert.equal(read?.name, 'read_file');
  assert.equal((read?.parameters as {type: string}).type, 'object');
  assert.deepEqual(
    (read?.parameters as {required: string[]}).required,
    ['path'],
  );
  assert.equal(definitions[1]?.function.name, 'bash');
});
