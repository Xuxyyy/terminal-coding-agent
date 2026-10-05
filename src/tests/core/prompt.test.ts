import assert from 'node:assert/strict';
import test from 'node:test';
import {sandboxInstructions, systemPrompt} from '../../core/prompt.js';

test('the prompt reserves a single-run verifier for final verification', () => {
  const prompt = systemPrompt(process.cwd());

  assert.match(prompt, /read and preserve any required order, availability, and retry\s+limits/);
  assert.match(prompt, /may run only once for final post-fix verification/);
  assert.match(prompt, /never spend that run on a baseline/);
  assert.match(prompt, /never retry it/);
  assert.match(prompt, /Follow the required verifier order exactly/);
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

test('auto strongly prefers bash but explains file-tool fallbacks and recovery limits', () => {
  const prompt = systemPrompt(process.cwd(), 'auto');

  assert.equal(systemPrompt(process.cwd()), prompt);
  assert.match(prompt, /Strongly prefer bash for reading, searching, editing, creating files, and running/);
  assert.match(prompt, /preference, not a restriction/);
  assert.match(prompt, /only when they offer a clear benefit/);
  assert.match(prompt, /exact-match replacement/);
  assert.match(prompt, /bash changes are not backed up for \/rewind/);
  assert.match(prompt, /Git cannot reliably recover overwritten\s+uncommitted work/);
  assert.match(prompt, /When file-tool session backups are available/);
  assert.match(prompt, /Shell searches do not inherit the grep tool's sensitive-file exclusions/);
  assert.match(prompt, /inspect its effects before retrying/);
  assert.doesNotMatch(prompt, /Use grep to find where something lives/);
  assert.doesNotMatch(prompt, /Prefer edit_file over write_file/);
});

test('the explicit edit modes keep their existing tool guidance', () => {
  const asking = systemPrompt(process.cwd(), 'ask-edits');
  const editing = systemPrompt(process.cwd(), 'auto-edits');

  assert.equal(asking, editing);
  assert.match(asking, /Use grep to find where something lives, then read_file to see it/);
  assert.match(asking, /Prefer edit_file over write_file for a file that already exists/);
  assert.doesNotMatch(asking, /Strongly prefer bash/);
});

test('tool preference does not change sandbox instructions in any mode', () => {
  for (const mode of ['ask-edits', 'auto-edits', 'auto'] as const) {
    for (const sandbox of ['on', 'off'] as const) {
      assert.ok(systemPrompt(process.cwd(), mode, sandbox).includes(sandboxInstructions(sandbox)));
    }
  }
});
