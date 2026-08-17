import assert from 'node:assert/strict';
import test from 'node:test';
import {matchPattern, normalizedStages, ruleVerdict} from '../../../core/permission/rules.js';
import type {Rules} from '../../../core/settings.js';

function rules(some: Partial<Rules>): Rules {
  return {allow: [], ask: [], deny: [], ...some};
}

const EMPTY = rules({});

test('a pattern matches the whole command and nothing longer', () => {
  assert.equal(matchPattern('npm run *', 'npm run build'), true);
  assert.equal(matchPattern('npm run *', 'npmx run build'), false);
  assert.equal(matchPattern('npm run *', 'sudo npm run build'), false);
  assert.equal(matchPattern('npm test', 'npm test'), true);
  assert.equal(matchPattern('npm test', 'npm test -- --watch'), false);
});

test('a star spans spaces and matches nothing at all', () => {
  assert.equal(matchPattern('git *', 'git log --oneline -5'), true);
  assert.equal(matchPattern('git status*', 'git status'), true);
  assert.equal(matchPattern('*', 'anything at all'), true);
});

test('every other metacharacter is literal', () => {
  assert.equal(matchPattern('ls ?', 'ls x'), false);
  assert.equal(matchPattern('ls ?', 'ls ?'), true);
  assert.equal(matchPattern('ls [a-z]', 'ls a'), false);
  assert.equal(matchPattern('ls [a-z]', 'ls [a-z]'), true);
  assert.equal(matchPattern('echo a.c', 'echo abc'), false);
  assert.equal(matchPattern('echo a+', 'echo aaa'), false);
  assert.equal(matchPattern('echo (a)', 'echo (a)'), true);
});

test('normalizedStages squeezes whitespace and splits on separators', () => {
  assert.deepEqual(normalizedStages('npm   run  build'), ['npm run build']);
  assert.deepEqual(normalizedStages('git status && rm -rf x'), [
    'git status',
    'rm -rf x',
  ]);
  assert.deepEqual(normalizedStages('  ls  '), ['ls']);
  assert.equal(normalizedStages('echo "unbalanced'), null);
});

test('extra whitespace still matches the rule', () => {
  const allowed = rules({allow: ['npm run *']});
  assert.equal(ruleVerdict('npm   run  build', allowed), 'allow');
  assert.equal(ruleVerdict(' npm run build ', allowed), 'allow');
});

test('deny beats ask beats allow', () => {
  const all = rules({
    deny: ['npm run *'],
    ask: ['npm run *'],
    allow: ['npm run *'],
  });
  assert.equal(ruleVerdict('npm run build', all), 'deny');

  const asking = rules({ask: ['npm run *'], allow: ['npm run *']});
  assert.equal(ruleVerdict('npm run build', asking), 'ask');

  assert.equal(ruleVerdict('npm run build', rules({allow: ['npm run *']})), 'allow');
});

test('one allowed stage cannot allow the rest of the command', () => {
  const allowed = rules({allow: ['git status*']});
  assert.equal(ruleVerdict('git status && rm -rf x', allowed), null);
  assert.equal(ruleVerdict('git status', allowed), 'allow');
});

test('every stage allowed allows the command', () => {
  const allowed = rules({allow: ['git status*', 'rm -rf *']});
  assert.equal(ruleVerdict('git status && rm -rf x', allowed), 'allow');
});

test('a denied stage denies the whole command', () => {
  const mixed = rules({allow: ['git status*'], deny: ['rm -rf *']});
  assert.equal(ruleVerdict('git status && rm -rf x', mixed), 'deny');
});

test('an asked stage asks about the whole command', () => {
  const mixed = rules({allow: ['git status*', 'curl *'], ask: ['curl *']});
  assert.equal(ruleVerdict('git status && curl example.com', mixed), 'ask');
});

test('a command that cannot be parsed is never allowed', () => {
  const allowed = rules({allow: ['echo *']});
  assert.equal(ruleVerdict('echo "unbalanced', allowed), null);

  const denied = rules({allow: ['echo *'], deny: ['echo *']});
  assert.equal(ruleVerdict('echo "unbalanced', denied), 'deny');

  const elsewhere = rules({deny: ['curl *']});
  assert.equal(ruleVerdict('echo "unbalanced', elsewhere), null);
});

test('no rules never reach a verdict', () => {
  for (const command of ['ls', 'sudo rm -rf /', 'npm run build', '']) {
    assert.equal(ruleVerdict(command, EMPTY), null, command);
  }
});
