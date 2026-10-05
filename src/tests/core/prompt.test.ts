import assert from 'node:assert/strict';
import test from 'node:test';
import {systemPrompt} from '../../core/prompt.js';

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
