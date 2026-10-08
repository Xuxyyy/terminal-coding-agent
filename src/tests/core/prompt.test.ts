import assert from 'node:assert/strict';
import test from 'node:test';
import {sandboxInstructions, systemPrompt} from '../../core/prompt.js';

test('the base prompt keeps concise guidance with repository and permission requirements', () => {
  const prompt = systemPrompt(process.cwd());

  assert.match(prompt, /You are a coding agent/);
  assert.match(prompt, /Follow applicable repository instructions/);
  assert.match(prompt, /Preserve unrelated existing changes/);
  assert.match(prompt, /Never use another tool to bypass a permission denial/);
  assert.match(prompt, /<environment>/);
  assert.ok(prompt.includes(`working directory: ${process.cwd()}`));
  assert.doesNotMatch(prompt, /Understand the task:|Work:|Use tools:|Verify and finish:/);
  assert.doesNotMatch(prompt, /Group independent|Before starting tool work|single-run|post-fix verification|Keep your final answer/);
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

test('the base prompt is shared across permission modes and leaves tool preferences to descriptions', () => {
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
