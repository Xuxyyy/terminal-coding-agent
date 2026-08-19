import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {z} from 'zod';
import type {ConfirmDecision, ConfirmRequest, Host} from '../../../core/host.js';
import {bash} from '../../../core/tools/bash.js';
import {editFile} from '../../../core/tools/edit.js';
import {grep} from '../../../core/tools/grep.js';
import {resolveInWorkspace} from '../../../core/tools/paths.js';
import {readFile} from '../../../core/tools/read.js';
import {runTool, toolDefinitions, type Tool, type ToolContext} from '../../../core/tools/registry.js';
import {writeFile} from '../../../core/tools/write.js';

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
  return {
    root,
    host,
    allowed: new Set<string>(),
    rules: {allow: [], ask: [], deny: []},
    mode: 'auto-edits',
  };
}

const ran: string[] = [];

const fakeBash: Tool = {
  name: 'bash',
  description: 'fake',
  schema: z.object({command: z.string()}),
  request(args) {
    return {kind: 'command', command: (args as {command: string}).command, reason: 'test'};
  },
  async run(args) {
    ran.push((args as {command: string}).command);
    return {text: '[exit 0]\nran'};
  },
};

const registry = [readFile, grep, editFile, writeFile, fakeBash];

function session(answers: ConfirmDecision[]) {
  const root = workspace();
  const {host, asked} = hostThatAnswers(...answers);
  ran.length = 0;
  return {ctx: context(root, host), asked, root};
}

function bashCall(ctx: ToolContext, command: string) {
  return runTool(registry, 'bash', JSON.stringify({command}), ctx);
}

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

test('a path outside the workspace is denied without a prompt', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    JSON.stringify({path: '../../etc/passwd'}),
    context(root, host),
  );

  assert.equal(output.text, "Error: reads '../../etc/passwd' outside the project");
  assert.equal(asked.length, 0);
});

test('a home path is refused by the gate, not by a missing file', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    JSON.stringify({path: '~/.ssh/id_rsa'}),
    context(root, host),
  );

  assert.equal(output.text, "Error: reads '~/.ssh/id_rsa' outside the project");
  assert.doesNotMatch(output.text, /ENOENT/);
  assert.equal(asked.length, 0);
});

test('read_file and grep answer the same for the same path', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const ctx = context(root, host);

  const read = await runTool(registry, 'read_file', JSON.stringify({path: '../secret'}), ctx);
  const searched = await runTool(
    registry,
    'grep',
    JSON.stringify({pattern: 'x', path: '../secret'}),
    ctx,
  );

  assert.equal(read.text, "Error: reads '../secret' outside the project");
  assert.equal(searched.text, read.text);
  assert.equal(asked.length, 0);
});

test('a link out of the workspace still throws in the resolver', () => {
  const root = fs.realpathSync(workspace());
  const outside = fs.realpathSync(workspace());
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x\n');
  fs.symlinkSync(outside, path.join(root, 'link'));

  assert.throws(
    () => resolveInWorkspace(root, 'link/secret.txt'),
    /escapes the workspace through a link/,
  );
});

test('an absolute path outside the workspace is denied without a prompt', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: '/etc/passwd', content: 'x'}),
    context(root, host),
  );

  assert.equal(output.text, "Error: '/etc/passwd' is outside the project");
  assert.equal(asked.length, 0);
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

const MAX_OUTPUT_CHARS = 32_000;

async function readAll(root: string, args: object = {}): Promise<string> {
  const {host} = hostThatAnswers('once');
  const output = await runTool(
    registry,
    'read_file',
    JSON.stringify({path: 'big.ts', ...args}),
    context(root, host),
  );
  return output.text;
}

function fileOf(root: string, lines: string[]): void {
  fs.writeFileSync(path.join(root, 'big.ts'), lines.join('\n') + '\n');
}

test('a read under the cap is left alone', async () => {
  const root = workspace();
  fileOf(
    root,
    Array.from({length: 50}, (_, i) => `line ${i + 1}`),
  );

  const text = await readAll(root);

  assert.doesNotMatch(text, /truncated \d+ chars/);
  assert.match(text, /50\tline 50$/);
});

test('a read over the cap keeps the head and says how much it cut', async () => {
  const root = workspace();
  fileOf(
    root,
    Array.from({length: 2_000}, (_, i) => `${'x'.repeat(60)} ${i + 1}`),
  );

  const text = await readAll(root, {limit: 2_000});

  assert.match(text, /\.\.\. \[truncated (\d+) chars, cap is 32000; re-read with offset\]/);
  const cut = Number(/truncated (\d+) chars/.exec(text)![1]);
  assert.ok(cut > 0, `expected a positive cut, got ${cut}`);
  assert.ok(
    text.length < MAX_OUTPUT_CHARS + 200,
    `expected roughly the cap, got ${text.length}`,
  );
});

test('an explicit limit cannot read past the cap', async () => {
  const root = workspace();
  fileOf(
    root,
    Array.from({length: 5_000}, (_, i) => `${'x'.repeat(60)} ${i + 1}`),
  );

  const text = await readAll(root, {limit: 100_000});

  assert.match(text, /truncated \d+ chars/);
  assert.ok(
    text.length < MAX_OUTPUT_CHARS + 200,
    `expected roughly the cap, got ${text.length}`,
  );
});

test('a truncated read starts at line 1 and ends on a whole line', async () => {
  const root = workspace();
  fileOf(
    root,
    Array.from({length: 2_000}, (_, i) => `${'x'.repeat(60)} ${i + 1}`),
  );

  const text = await readAll(root, {limit: 2_000});
  const body = text.slice(0, text.indexOf('\n... [truncated'));
  const rows = body.split('\n');

  assert.match(rows[0]!, /^\s*1\t/);
  for (const [index, row] of rows.entries()) {
    assert.match(
      row,
      new RegExp(`^\\s*${index + 1}\\t${'x'.repeat(60)} ${index + 1}$`),
      `row ${index + 1} is not a whole numbered line`,
    );
  }
});

test('the line cap and the output cap compose', async () => {
  const root = workspace();
  fileOf(
    root,
    Array.from({length: 500}, () => 'y'.repeat(900)),
  );

  const text = await readAll(root, {limit: 500});

  assert.match(text, /truncated \d+ chars/);
  assert.ok(
    text.length < MAX_OUTPUT_CHARS + 200,
    `expected roughly the cap, got ${text.length}`,
  );
  assert.match(text, /y{500}\.\.\. \[truncated\]/);
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

test('declining a command does not execute it', async () => {
  const {ctx, asked} = session(['deny']);

  const output = await bashCall(ctx, 'rm -rf /');

  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.command, 'rm -rf /');
  assert.equal(asked[0]?.suppressible, false);
  assert.equal(ran.length, 0);
  assert.equal(
    output.text,
    'Error: user denied this command; try another approach',
  );
});

test('a change inside the project is reviewed once', async () => {
  const {ctx, asked} = session(['session']);

  await bashCall(ctx, 'rm build.log');
  await bashCall(ctx, 'rm  build.log');

  assert.equal(asked.length, 1);
  assert.equal(ran.length, 2);
});

test('approving one command does not approve another', async () => {
  const {ctx, asked} = session(['session']);

  await bashCall(ctx, 'rm build.log');
  assert.equal(asked.length, 1);

  await bashCall(ctx, 'rm other.log');
  assert.equal(asked.length, 2);
  assert.equal(asked[1]?.command, 'rm other.log');
});

test('a guardrail is never remembered even when asked to', async () => {
  const {ctx, asked} = session(['session']);

  await bashCall(ctx, 'git push origin main');
  await bashCall(ctx, 'git push origin main');

  assert.equal(asked.length, 2);
  assert.equal(asked[0]?.suppressible, false);
});

test('approving once does not cover the next call', async () => {
  const {ctx, asked} = session(['once']);

  await bashCall(ctx, 'rm build.log');
  await bashCall(ctx, 'rm build.log');

  assert.equal(asked.length, 2);
});

test('a declined command is not remembered', async () => {
  const {ctx, asked} = session(['deny']);

  await bashCall(ctx, 'rm build.log');
  await bashCall(ctx, 'rm build.log');

  assert.equal(asked.length, 2);
  assert.equal(ran.length, 0);
});

test('known reads run without review', async () => {
  const {ctx, asked} = session(['deny']);

  await bashCall(ctx, 'ls -la');
  await bashCall(ctx, 'git status');
  await bashCall(ctx, 'npm test');

  assert.equal(asked.length, 0);
  assert.equal(ran.length, 3);
});

test('the hardened command is what runs', async () => {
  const {ctx, asked} = session(['deny']);

  await bashCall(ctx, 'git diff');

  assert.equal(asked.length, 0);
  assert.deepEqual(ran, ['git diff --no-ext-diff']);
});

test('a write tool asks before touching a protected path', async () => {
  const {ctx, asked, root} = session(['deny']);
  fs.mkdirSync(path.join(root, '.git'), {recursive: true});

  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: '.git/config', content: 'x'}),
    ctx,
  );

  assert.equal(asked.length, 1);
  assert.match(asked[0]?.reason ?? '', /protected path/);
  assert.match(output.text, /^Error: /);
  assert.equal(fs.existsSync(path.join(root, '.git', 'config')), false);
});

test('an edit tool asks before changing a protected path', async () => {
  const {ctx, asked, root} = session(['deny']);
  fs.mkdirSync(path.join(root, '.git'), {recursive: true});
  const config = path.join(root, '.git', 'config');
  fs.writeFileSync(config, '[core]\n');

  const output = await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: '.git/config', old_string: '[core]', new_string: '[remote]'}),
    ctx,
  );

  assert.equal(asked.length, 1);
  assert.match(asked[0]?.reason ?? '', /protected path/);
  assert.match(output.text, /^Error: /);
  assert.equal(fs.readFileSync(config, 'utf8'), '[core]\n');
});

function watching(answers: ConfirmDecision[], backup?: (path: string) => void) {
  const {ctx, asked, root} = session(answers);
  const seen: Array<{path: string; bytes: string | null}> = [];
  ctx.backup = (asked: string) => {
    const target = path.join(root, asked);
    seen.push({
      path: asked,
      bytes: fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
    });
    backup?.(asked);
  };
  return {ctx, asked, root, seen};
}

test('write_file is captured before it changes the file', async () => {
  const {ctx, root, seen} = watching(['once']);
  fs.writeFileSync(path.join(root, 'a.ts'), 'old\n');

  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: 'a.ts', content: 'new\n'}),
    ctx,
  );

  assert.deepEqual(seen, [{path: 'a.ts', bytes: 'old\n'}]);
  assert.match(output.text, /^Wrote /);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'new\n');
});

test('edit_file is captured before it changes the file', async () => {
  const {ctx, root, seen} = watching(['once']);
  fs.writeFileSync(path.join(root, 'a.ts'), 'a = 1\n');

  const output = await runTool(
    registry,
    'edit_file',
    JSON.stringify({path: 'a.ts', old_string: 'a = 1', new_string: 'a = 2'}),
    ctx,
  );

  assert.deepEqual(seen, [{path: 'a.ts', bytes: 'a = 1\n'}]);
  assert.equal(output.text, "Edited 'a.ts'.");
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'a = 2\n');
});

test('a write the user denied is never captured', async () => {
  const {ctx, root, seen} = watching(['deny']);
  fs.mkdirSync(path.join(root, '.git'), {recursive: true});
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');

  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: '.git/config', content: 'x'}),
    ctx,
  );

  assert.deepEqual(seen, []);
  assert.match(output.text, /^Error: /);
});

test('a tool that writes nothing is never captured', async () => {
  const {ctx, root, seen} = watching(['once']);
  fs.writeFileSync(path.join(root, 'a.ts'), 'a = 1\n');

  await runTool(registry, 'read_file', JSON.stringify({path: 'a.ts'}), ctx);
  await bashCall(ctx, 'git diff');

  assert.deepEqual(seen, []);
});

test('a capture that fails does not fail the write', async () => {
  const {ctx, root, seen} = watching(['once'], () => {
    throw new Error('disk full');
  });
  fs.writeFileSync(path.join(root, 'a.ts'), 'old\n');

  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: 'a.ts', content: 'new\n'}),
    ctx,
  );

  assert.equal(seen.length, 1);
  assert.match(output.text, /^Wrote /);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'new\n');
});

test('a write runs the same when nothing is capturing', async () => {
  const {ctx, root} = session(['once']);
  fs.writeFileSync(path.join(root, 'a.ts'), 'old\n');

  const output = await runTool(
    registry,
    'write_file',
    JSON.stringify({path: 'a.ts', content: 'new\n'}),
    ctx,
  );

  assert.match(output.text, /^Wrote /);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'new\n');
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
