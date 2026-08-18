import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {ConfirmDecision, ConfirmRequest, Host} from '../../../core/host.js';
import {bash} from '../../../core/tools/bash.js';
import {grep} from '../../../core/tools/grep.js';
import {runTool, type ToolContext} from '../../../core/tools/registry.js';
import {systemPrompt} from '../../../core/prompt.js';

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
  return {root, host, allowed: new Set<string>(), rules: {allow: [], ask: [], deny: []}};
}

const registry = [grep];

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content);
}

function seeded(): string {
  const root = workspace();
  write(root, 'a.ts', 'const widget = 1;\nconst other = 2;\n');
  write(root, 'src/b.ts', 'export function widget() {}\n');
  write(root, 'notes.md', 'nothing here\n');
  return root;
}

async function search(root: string, args: object, answers: ConfirmDecision[] = ['once']) {
  const {host, asked} = hostThatAnswers(...answers);
  const output = await runTool(registry, 'grep', JSON.stringify(args), context(root, host));
  return {text: output.text, asked};
}

test('a search outside the project is denied without a prompt', async () => {
  const root = seeded();

  const {text, asked} = await search(root, {pattern: 'x', path: '~/.ssh'});

  assert.equal(text, "Error: reads '~/.ssh' outside the project");
  assert.deepEqual(asked, []);
});

test('a match returns the file paths and nothing else', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'widget'});

  assert.deepEqual(text.split('\n').sort(), ['a.ts', 'src/b.ts']);
});

test('content mode returns the matching lines with line numbers', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'widget', output_mode: 'content'});

  assert.match(text, /^a\.ts:1:const widget = 1;$/m);
  assert.match(text, /^src\/b\.ts:1:export function widget\(\) \{\}$/m);
});

test('count mode returns per-file counts and a total', async () => {
  const root = seeded();
  write(root, 'a.ts', 'widget\nwidget\n');

  const {text} = await search(root, {pattern: 'widget', output_mode: 'count'});

  assert.match(text, /^a\.ts:2$/m);
  assert.match(text, /^3 matches in 2 files$/m);
});

test('an absent pattern says how many files it searched', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'nosuchthing'});

  assert.match(text, /^no matches — searched (\d+) files$/);
  assert.ok(Number(/searched (\d+) files/.exec(text)![1]) > 0);
});

test('a glob that selects nothing names the glob', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'widget', glob: '*.nope'});

  assert.equal(text, "no files matched glob '*.nope'");
});

test('an invalid pattern is reported and does not throw', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'a['});

  assert.match(text, /^invalid pattern: /);
  assert.match(text, /unclosed character class/);
});

test('a path outside the workspace is rejected', async () => {
  const root = seeded();

  const {text, asked} = await search(root, {pattern: 'widget', path: '../../etc'});

  assert.equal(text, "Error: reads '../../etc' outside the project");
  assert.deepEqual(asked, []);
});

test('a path that does not exist is an error, not no matches', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'widget', path: 'nowhere'});

  assert.equal(text, 'Error: path not found: nowhere');
  assert.doesNotMatch(text, /no matches/);
});

test('a gitignored file is skipped and a dotfile is found', async () => {
  const root = seeded();
  write(root, '.gitignore', 'build/\n');
  write(root, 'build/generated.ts', 'const widget = 3;\n');
  write(root, '.acc/settings.json', '{"widget": true}\n');

  const {text} = await search(root, {pattern: 'widget'});
  const files = text.split('\n').sort();

  assert.ok(!files.includes('build/generated.ts'), text);
  assert.ok(files.includes('.acc/settings.json'), text);
});

test('.git is never searched', async () => {
  const root = seeded();
  write(root, '.git/config', 'widget = yes\n');

  const {text} = await search(root, {pattern: 'widget'});

  assert.ok(!text.includes('.git/config'), text);
});

test('a path narrows the search to one directory', async () => {
  const root = seeded();

  const {text} = await search(root, {pattern: 'widget', path: 'src'});

  assert.equal(text, 'src/b.ts');
});

test('case_insensitive matches a different case', async () => {
  const root = seeded();
  write(root, 'c.ts', 'const WIDGET = 4;\n');

  const {text} = await search(root, {pattern: 'WIDGET', case_insensitive: true});

  assert.ok(text.split('\n').includes('a.ts'), text);
});

test('output past the cap ends with the truncation marker', async () => {
  const root = workspace();
  const line = `${'x'.repeat(120)} widget`;
  write(root, 'big.ts', Array.from({length: 2_000}, () => line).join('\n') + '\n');

  const {text} = await search(root, {pattern: 'widget', output_mode: 'content'});

  assert.match(
    text,
    /\.\.\. \[truncated (\d+) chars, cap is 32000; narrow with glob or path\]$/,
  );
  assert.ok(text.length < 32_000 + 200, `expected roughly the cap, got ${text.length}`);
});

test('grep never asks the user', async () => {
  const root = seeded();

  const {text, asked} = await search(root, {pattern: 'widget'}, ['deny']);

  assert.equal(asked.length, 0);
  assert.doesNotMatch(text, /^Error: /);

  const inside = await search(root, {pattern: 'widget', path: 'src'}, ['deny']);
  assert.equal(inside.asked.length, 0);
  assert.doesNotMatch(inside.text, /^Error: /);
});

test('nothing still teaches the model to search with grep -rn', () => {
  assert.doesNotMatch(systemPrompt(process.cwd()), /grep -rn/);
  assert.doesNotMatch(bash.description, /grep -rn/);
});

test('both steering strings name the grep tool', () => {
  assert.match(systemPrompt(process.cwd()), /\bgrep\b/);
  assert.match(bash.description, /\bgrep\b/);
});
