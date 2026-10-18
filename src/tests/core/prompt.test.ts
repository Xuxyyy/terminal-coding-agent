import assert from 'node:assert/strict';
import {copyFile, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {sandboxInstructions, systemPrompt} from '../../core/prompt.js';

test('the build embeds the exact Markdown prompt without runtime source files', async (t) => {
  const source = await readFile(new URL('../../../src/core/system-prompt.md', import.meta.url), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'acc-embedded-prompt-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const standalone = join(directory, 'system-prompt.mjs');
  await copyFile(new URL('../../core/system-prompt.js', import.meta.url), standalone);
  const embedded = await import(pathToFileURL(standalone).href);

  assert.equal(embedded.default, source);
  assert.ok(systemPrompt(process.cwd()).startsWith(`${source}\n\nSandbox:`));
});

test('the base prompt uses reusable guidance with accurate ACC runtime instructions', () => {
  const prompt = systemPrompt(process.cwd());

  assert.match(prompt, /You are an interactive agent that helps users with software engineering tasks/);
  assert.match(prompt, /denied by the user or by ACC's permission checks/);
  assert.match(prompt, /Never use another tool to bypass a permission denial/);
  assert.match(prompt, /Prefer the dedicated file\/search tools/);
  assert.match(prompt, /ACC executes tool calls sequentially/);
  assert.match(prompt, /<environment>/);
  assert.ok(prompt.includes(`working directory: ${process.cwd()}`));
  assert.match(prompt, /^platform: .+$/m);
  assert.match(prompt, /^git repository: (yes|no)$/m);
  assert.doesNotMatch(prompt, /^files:$/m);
  assert.doesNotMatch(prompt, /Runtime preview|\/TASK_WORKING_DIRECTORY|<configured maxSteps>|<task operating system/);
  assert.doesNotMatch(prompt, /Follow applicable repository instructions|Preserve unrelated existing changes|Keep the implementation focused|Preserve existing behavior|Add features, options, or fallbacks|Once a candidate solution|Repeat or expand checks/);
  assert.doesNotMatch(prompt, /Anthropic|Claude|Skill|MEMORY\.md|capture-config|<total_tokens>|Hooks may intercept|can run in parallel|it's clickable/);
});

test('the prompt describes only the selected sandbox mode', () => {
  const off = systemPrompt(process.cwd());
  assert.match(off, /Sandbox: Off/);
  assert.match(off, /does not stop commands from reading credential files/);
  assert.doesNotMatch(off, /Known credential storage is hidden/);
  const on = systemPrompt(process.cwd(), 'auto-edits', 'on');
  assert.match(on, /Sandbox: On/);
  assert.match(on, /never falls back to Off/);
});

test('the base prompt is shared across permission modes', () => {
  const prompt = systemPrompt(process.cwd(), 'auto');

  assert.equal(systemPrompt(process.cwd()), prompt);
  assert.equal(systemPrompt(process.cwd(), 'ask-edits'), prompt);
  assert.equal(systemPrompt(process.cwd(), 'auto-edits'), prompt);
  assert.doesNotMatch(prompt, /Prefer bash|Prefer edit_file|Use grep|old_string|\/rewind/);
});

test('tool preference does not change sandbox instructions in any mode', () => {
  for (const mode of ['ask-edits', 'auto-edits', 'auto'] as const) {
    for (const sandbox of ['on', 'off'] as const) {
      assert.ok(systemPrompt(process.cwd(), mode, sandbox).includes(sandboxInstructions(sandbox)));
    }
  }
});
