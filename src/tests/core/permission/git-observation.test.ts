import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {classifyCommand} from '../../../core/permission/classify.js';
import {decide} from '../../../core/permission/decide.js';
import {MODES} from '../../../core/permission/mode.js';

const reads = [
  'git log --graph --oneline --decorate -n 10 d7d3e4b c499730',
  'git log --graph --decorate=full --oneline -n 6 && git status',
  'git log --no-decorate -5',
  'git branch',
  'git branch -a',
  'git branch -rvv',
  'git branch --list',
  'git branch --list main',
  'git branch -alv main',
  'git branch --show-current',
  'git reflog',
  'git reflog -n 20',
  'git reflog show --oneline -5 HEAD',
  'git stash list',
  'git stash list -n 5 --format=%h',
  'git config --list --show-origin',
  'git config -lz --local',
  'git config list --show-origin --show-scope',
  'git status && git branch -a && git reflog -n 20 && git stash list',
];

test('Git listing commands are observations in every permission mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-git-reads-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const command of reads) {
    assert.equal(classifyCommand(command, root).tier, 'observe', command);
    for (const mode of MODES) {
      assert.equal(decide({kind: 'command', command}, root, undefined, mode).decision, 'allow', `${mode}: ${command}`);
    }
  }
});

test('Git listing support does not allow writes or unknown options', () => {
  for (const command of [
    'git branch new-branch', 'git branch -a new-branch',
    'git branch -- --list', 'git branch -D old', 'git branch -d old',
    'git branch --delete old', 'git branch -m old new', 'git branch -C old new',
    'git branch --list -D old', 'git branch --list --edit-description main',
    'git branch --set-upstream-to=origin/main', 'git branch --create-reflog main',
    'git reflog expire --all', 'git reflog delete HEAD@{0}',
    'git reflog drop --all', 'git reflog write HEAD old new message',
    'git stash', 'git stash push', 'git stash pop', 'git stash apply',
    'git stash drop', 'git stash clear', 'git stash list --output=out.txt',
    'git reflog show --output=out.txt', 'git reflog show --ext-diff -p',
    'git stash list --textconv -p',
    'git config user.name Someone', 'git config --add user.name Someone',
    'git config --unset user.name', 'git config --edit',
    'git config --list --unset user.name', 'git config list --file ../config',
    'git config --list --file=.env', 'git config set user.name Someone',
    'git config -- --list', 'git config list user.name Someone',
    'git log --graph --output=out.txt', 'git log --graph --ext-diff',
    'git log --graph --textconv', 'git log --graph --unknown-option',
    'git -c alias.branch=custom branch -a',
    'git branch -a && git branch -D old',
    'git stash list && git stash drop',
  ]) {
    assert.equal(classifyCommand(command, process.cwd()).tier, 'needs-checking', command);
    assert.equal(decide({kind: 'command', command}, process.cwd()).decision, 'judge', command);
  }
});

test('Git observations retain redirect and outside-path checks', () => {
  for (const command of [
    'git branch -a > .git/config',
    'git reflog -n 20 > ../reflog.txt',
    'git stash list > .npmrc',
    'git config --list --show-origin > .git/config',
    'git log --graph -- ../outside.txt',
  ]) {
    assert.equal(decide({kind: 'command', command}, process.cwd()).decision, 'judge', command);
  }
  const redirected = classifyCommand('git stash list > stash.txt', process.cwd());
  assert.equal(redirected.tier, 'recoverable');
  assert.equal(decide({kind: 'command', command: 'git stash list > stash.txt'}, process.cwd(), undefined, 'ask-edits').decision, 'ask');
});

test('saved ask and deny rules still override recognized Git listings', () => {
  for (const command of reads) {
    for (const verdict of ['ask', 'deny'] as const) {
      const rules = {allow: [], ask: [], deny: [], [verdict]: [{tag: 'bash' as const, pattern: 'git *'}]};
      assert.equal(decide({kind: 'command', command}, process.cwd(), rules).decision, verdict, command);
    }
  }
});
