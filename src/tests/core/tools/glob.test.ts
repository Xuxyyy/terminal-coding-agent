import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import {INTERRUPTED, type ConfirmRequest} from '../../../core/host.js';
import {glob} from '../../../core/tools/glob.js';
import {runTool, toolDefinitions, type ToolContext} from '../../../core/tools/registry.js';
import {childTools} from '../../../core/tools/subagent.js';

function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-glob-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function write(root: string, name: string, time = 1_000): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, 'fixture');
  fs.utimesSync(file, time, time);
}

function context(root: string, answer: 'once' | 'deny' = 'once') {
  const asked: ConfirmRequest[] = [];
  const controller = new AbortController();
  const ctx: ToolContext = {
    root, mode: 'auto-edits', sandbox: 'off', allowed: new Set(),
    rules: {allow: [], ask: [], deny: []},
    host: {
      signal: controller.signal,
      onEvent() {},
      async confirm(request) { asked.push(request); return answer; },
    },
  };
  return {ctx, asked, controller};
}

async function search(ctx: ToolContext, args: object) {
  return (await runTool([glob], 'glob', JSON.stringify(args), ctx)).text;
}

test('glob exposes only pattern and optional directory and is usable by edit-mode children', () => {
  const schema = toolDefinitions([glob])[0]!.function.parameters;
  assert.deepEqual(schema.required, ['pattern']);
  assert.deepEqual(Object.keys(schema.properties as object), ['pattern', 'path']);
  assert.deepEqual(childTools('ask-edits', ['glob']).map((tool) => tool.name), ['glob']);
  assert.deepEqual(childTools('auto', ['glob']), []);
});

for (const sandbox of ['off', 'on'] as const) {
  test(`${sandbox}: glob matches files and sorts across directories by date, then path`, {skip: sandbox === 'on' && process.platform !== 'darwin'}, async (t) => {
    const root = workspace(t);
    write(root, 'old.ts', 100);
    write(root, 'a/new.ts', 400);
    write(root, 'z/middle.tsx', 200);
    write(root, 'b/tie.ts', 400);
    write(root, 'other.js', 500);
    fs.mkdirSync(path.join(root, 'directory.ts'));
    const {ctx, asked} = context(root);
    ctx.sandbox = sandbox;
    assert.equal(await search(ctx, {pattern: '**/*.{ts,tsx}'}), 'a/new.ts\nb/tie.ts\nz/middle.tsx\nold.ts');
    assert.equal(asked.length, 0);
    assert.equal(await search(ctx, {pattern: '*.ts', path: 'a'}), 'a/new.ts');
    assert.equal(await search(ctx, {pattern: '*.ts', path: path.join(root, 'a')}), 'a/new.ts');
  });
}

test('glob includes ignored and hidden files but always excludes sensitive names', async (t) => {
  const root = workspace(t);
  write(root, '.gitignore');
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
  write(root, 'build/generated.ts');
  write(root, '.notes/a.ts');
  write(root, '.acc/local.ts');
  write(root, '.git/config');
  write(root, '.env.test');
  write(root, 'nested/private.key');
  const {ctx} = context(root);
  assert.deepEqual((await search(ctx, {pattern: '**/*'})).split('\n'), ['.gitignore', '.notes/a.ts', 'build/generated.ts']);
  assert.match(await search(ctx, {pattern: '**/*', path: '.acc'}), /^Error: search directory is excluded/);
  assert.match(await search(ctx, {pattern: '**/*.key'}), /^no files matched/);
});

test('glob does not follow symlinks or search outside through a pattern', async (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  write(outside, 'away.ts');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  fs.symlinkSync(path.join(outside, 'away.ts'), path.join(root, 'linked.ts'));
  const {ctx} = context(root);
  assert.match(await search(ctx, {pattern: '**/*.ts'}), /^no files matched/);
  for (const pattern of ['../**', '/**', '!**/*.ts', 'a/../**', '', 'x\0y']) {
    assert.match(await search(ctx, {pattern}), /^Error: invalid arguments/);
  }
});

test('glob separates missing paths, files, invalid globs, and empty matches', async (t) => {
  const root = workspace(t);
  write(root, 'a.ts');
  const {ctx} = context(root);
  assert.match(await search(ctx, {pattern: '**/*', path: 'missing'}), /^Error: path not found/);
  assert.match(await search(ctx, {pattern: '**/*', path: 'a.ts'}), /^Error: not a directory/);
  assert.match(await search(ctx, {pattern: '['}), /^Error: glob search failed:/);
  assert.equal(await search(ctx, {pattern: '**/*.py'}), "no files matched glob '**/*.py'");
  assert.match(await search(ctx, {pattern: '**/*', path: 'x\0y'}), /^Error: invalid arguments/);
});

test('glob asks for outside directories, honors denial, and filters denied files', async (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  write(outside, 'away.ts');
  const allowed = context(root);
  assert.equal(await search(allowed.ctx, {pattern: '*.ts', path: outside}), path.join(outside, 'away.ts'));
  assert.equal(allowed.asked.length, 1);
  assert.equal(allowed.asked[0]!.suppressible, false);
  const denied = context(root, 'deny');
  assert.match(await search(denied.ctx, {pattern: '*.ts', path: outside}), /^Error: the user refused/);
  write(root, 'visible.ts');
  write(root, 'blocked/hidden.ts');
  allowed.ctx.rules.deny = [{tag: 'edit', pattern: 'blocked/**'}];
  assert.equal(await search(allowed.ctx, {pattern: '**/*.ts'}), 'visible.ts');
  assert.match(await search(allowed.ctx, {pattern: '**/*', path: 'blocked'}), /^no files matched/);
  allowed.ctx.rules.deny.push({tag: 'edit', pattern: 'blocked'});
  assert.match(await search(allowed.ctx, {pattern: '**/*', path: 'blocked'}), /^Error:/);
});

test('sandbox glob grants an outside directory for one call and blocks credential storage', {skip: process.platform !== 'darwin'}, async (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  write(outside, 'away.ts');
  const {ctx, asked} = context(root);
  ctx.sandbox = 'on';
  assert.equal(await search(ctx, {pattern: '*.ts', path: outside}), path.join(outside, 'away.ts'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.suppressible, false);
  assert.match(await search(ctx, {pattern: '**/*', path: '~/.ssh'}), /sandbox blocks credential storage/);
  assert.equal(asked.length, 1);
});

test('glob returns the newest 100 and marks truncation', async (t) => {
  const root = workspace(t);
  for (let i = 0; i < 105; i++) write(root, `${i}.ts`, i + 100);
  const text = await search(context(root).ctx, {pattern: '*.ts'});
  const lines = text.split('\n');
  assert.equal(lines.length, 101);
  assert.equal(lines[0], '104.ts');
  assert.equal(lines[99], '5.ts');
  assert.match(lines[100]!, /showing 100 of 105 files/);
});

test('glob caps long paths on whole entries and quotes unusual filenames', async (t) => {
  const root = workspace(t);
  const directory = Array.from({length: 4}, () => 'x'.repeat(100)).join('/');
  for (let i = 0; i < 100; i++) write(root, `${directory}/${i}.ts`);
  write(root, 'line\nbreak.ts', 2_000);
  write(root, '-flag.ts', 1_500);
  const text = await search(context(root).ctx, {pattern: '**/*.ts'});
  assert.ok(text.length <= 32_000);
  assert.equal(text.split('\n')[0], '"line\\nbreak.ts"');
  assert.match(text, /truncated/);
  assert.equal(await search(context(root).ctx, {pattern: '-flag.ts'}), '-flag.ts');
});

test('glob reports missing ripgrep and cancels an active search', async (t) => {
  const root = workspace(t);
  const original = process.env.PATH;
  t.after(() => { process.env.PATH = original; });
  process.env.PATH = '';
  assert.match(await search(context(root).ctx, {pattern: '**/*'}), /ripgrep .* is not on PATH/);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'rg'), '#!/bin/sh\nexec /bin/sleep 60\n', {mode: 0o755});
  process.env.PATH = bin;
  const {ctx, controller} = context(root);
  const timer = setTimeout(() => controller.abort(), 250);
  t.after(() => clearTimeout(timer));
  assert.equal(await search(ctx, {pattern: '**/*'}), INTERRUPTED);
});

test('glob preserves partial results and marks access errors', async (t) => {
  const root = workspace(t);
  write(root, 'a.ts');
  const original = process.env.PATH;
  t.after(() => { process.env.PATH = original; });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'rg'), '#!/bin/sh\nprintf "a.ts\\0"\nprintf "Permission denied" >&2\nexit 2\n', {mode: 0o755});
  process.env.PATH = bin;
  const text = await search(context(root).ctx, {pattern: '*.ts'});
  assert.equal(text, 'a.ts\n[search incomplete: some paths could not be accessed]');
});

test('glob reports a timeout rather than an empty match', {timeout: 40_000}, async (t) => {
  const root = workspace(t);
  const original = process.env.PATH;
  t.after(() => { process.env.PATH = original; });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'rg'), '#!/bin/sh\nexec /bin/sleep 60\n', {mode: 0o755});
  process.env.PATH = bin;
  assert.equal(await search(context(root).ctx, {pattern: '**/*'}), 'Error: search timed out after 30s; narrow pattern or path');
});
