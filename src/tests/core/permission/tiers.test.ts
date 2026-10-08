import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {classifyCommand, classifyRead, classifyWrite, type CheckCause, type Tier} from '../../../core/permission/classify.js';
import {decide} from '../../../core/permission/decide.js';

test('tiers, check reasons, and approval restrictions are separate for files and commands', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-tiers-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  const cases: [string, Tier, CheckCause | null][] = [
    ['cat source.txt', 'observe', null],
    ['touch output.txt', 'recoverable', null],
    ['touch .npmrc', 'needs-checking', 'protected'],
    ['rm output.txt', 'needs-checking', 'destroy'],
    ['git push', 'needs-checking', 'escape'],
    ['cat ../outside.txt', 'needs-checking', 'escape'],
    ['node script.mjs', 'needs-checking', 'unknown'],
    ['cat "unfinished', 'needs-checking', 'unknown'],
  ];
  for (const [command, tier, cause] of cases) {
    const result = classifyCommand(command, project);
    assert.equal(result.tier, tier, command);
    assert.equal(result.cause, cause, command);
    assert.deepEqual(result.restrictions, {mustCheck: cause === 'escape', onceOnly: cause === 'escape'}, command);
  }
  assert.deepEqual(classifyWrite('.npmrc', project), classifyCommand('touch .npmrc', project));
  assert.equal(classifyRead('.npmrc', project).tier, 'observe');
  for (const classify of [classifyRead, classifyWrite]) {
    const outside = classify('../outside.txt', project);
    assert.equal(outside.tier, 'needs-checking');
    assert.equal(outside.cause, 'escape');
    assert.deepEqual(outside.restrictions, {mustCheck: true, onceOnly: true});
  }
});

test('combining stages keeps restrictions and the existing explanation priority', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-tier-chains-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  for (const command of ['touch .npmrc && rm output.txt', 'rm output.txt && touch .npmrc']) {
    const result = classifyCommand(command, project);
    assert.equal(result.tier, 'needs-checking');
    assert.equal(result.cause, 'destroy');
    assert.equal(result.reason, "deletes 'output.txt', which cannot be undone");
  }
  for (const command of ['node script.mjs && rm output.txt', 'rm output.txt && node script.mjs']) {
    const result = classifyCommand(command, project);
    assert.equal(result.tier, 'needs-checking');
    assert.equal(result.cause, 'unknown');
    assert.equal(result.reason, '');
  }
  for (const command of ['node script.mjs && git push', 'git push && node script.mjs', 'touch .npmrc && git push']) {
    const result = classifyCommand(command, project);
    assert.equal(result.tier, 'needs-checking');
    assert.equal(result.cause, 'escape');
    assert.equal(result.reason, 'git push');
    assert.deepEqual(result.restrictions, {mustCheck: true, onceOnly: true});
  }
});

test('check reasons preserve rule priority, judge routing, and remembered-approval eligibility', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-tier-decisions-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  for (const command of ['touch .npmrc', 'rm output.txt', 'node script.mjs', 'git push']) {
    for (const mode of ['ask-edits', 'auto-edits', 'auto'] as const) {
      const restricted = command === 'git push';
      const request = {kind: 'command' as const, command, reason: 'requested task'};
      const plain = decide(request, project, undefined, mode);
      assert.equal(plain.decision, mode === 'auto' ? 'judge' : 'ask');
      assert.equal(plain.suppressible, !restricted);
      if (command === 'node script.mjs') assert.equal(plain.reason, 'requested task');
      for (const verdict of ['allow', 'ask', 'deny'] as const) {
        const rules = {allow: [], ask: [], deny: [], [verdict]: [{tag: 'bash' as const, pattern: '*'}]};
        const result = decide(request, project, rules, mode);
        assert.equal(result.decision, verdict === 'deny' ? 'deny' : restricted ? plain.decision : verdict);
        assert.equal(result.suppressible, verdict !== 'deny' && !restricted);
      }
    }
  }
});
