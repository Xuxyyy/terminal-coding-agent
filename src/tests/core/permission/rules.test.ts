import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  matchPath,
  matchPattern,
  normalizedStages,
  patternScore,
  relativeTo,
  ruleVerdict,
} from '../../../core/permission/rules.js';
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

test('patternScore counts every character that is not a star', () => {
  assert.equal(patternScore('*'), 0);
  assert.equal(patternScore('git *'), 4);
  assert.equal(patternScore('git push *'), 9);
  assert.equal(patternScore('git * main'), 9);
});

test('the narrower pattern wins whichever list it sits in', () => {
  const narrowAllow = rules({deny: ['*'], allow: ['git *']});
  assert.equal(ruleVerdict('git status', narrowAllow), 'allow');

  const narrowDeny = rules({allow: ['*'], deny: ['git *']});
  assert.equal(ruleVerdict('git status', narrowDeny), 'deny');
});

test('ask on everything still lets the listed commands through', () => {
  const config = rules({
    ask: ['*'],
    allow: ['git *', 'npm run *'],
    deny: ['git push *', 'rm *'],
  });
  assert.equal(ruleVerdict('git status', config), 'allow');
  assert.equal(ruleVerdict('npm run build', config), 'allow');
  assert.equal(ruleVerdict('curl example.com', config), 'ask');
  assert.equal(ruleVerdict('rm -rf x', config), 'deny');
});

test('an equal score is broken by the stricter verdict', () => {
  const tied = rules({allow: ['git * main'], deny: ['git push *']});
  assert.equal(patternScore('git * main'), patternScore('git push *'));
  assert.equal(ruleVerdict('git push main', tied), 'deny');
});

test('the worst stage wins even when another stage matched something narrower', () => {
  const mixed = rules({allow: ['git *'], ask: ['*']});
  assert.equal(ruleVerdict('git status && curl x', mixed), 'ask');
});

test('a broad allow cannot rescue a command that will not parse', () => {
  const denied = rules({allow: ['*'], deny: ['echo *']});
  assert.equal(ruleVerdict('echo "unbalanced', denied), 'deny');

  const allowed = rules({allow: ['*']});
  assert.equal(ruleVerdict('echo "unbalanced', allowed), null);
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-paths-')));

test('a star in a path pattern stops at a slash', () => {
  assert.equal(matchPath('docs/*.mdx', 'docs/a.mdx'), true);
  assert.equal(matchPath('docs/*.mdx', 'docs/deep/a.mdx'), false);
  assert.equal(matchPath('docs/*.mdx', 'docs/a.md'), false);
  assert.equal(matchPath('src/*', 'src/a.ts'), true);
  assert.equal(matchPath('src/*', 'src/core/a.ts'), false);
});

test('a double star crosses slashes and does not match the bare directory', () => {
  assert.equal(matchPath('docs/**', 'docs/a.mdx'), true);
  assert.equal(matchPath('docs/**', 'docs/deep/a.mdx'), true);
  assert.equal(matchPath('docs/**', 'docs'), false);
  assert.equal(matchPath('docs/**', 'docsy/a.mdx'), false);
});

test('a lone star matches every path, tree included', () => {
  assert.equal(matchPath('*', 'README.md'), true);
  assert.equal(matchPath('*', 'src/core/loop.ts'), true);
  assert.equal(matchPath('**', 'src/core/loop.ts'), true);
});

test('a trailing slash means the directory and everything under it', () => {
  for (const target of ['src/a.ts', 'src/core/loop.ts']) {
    assert.equal(matchPath('src/', target), matchPath('src/**', target), target);
    assert.equal(matchPath('src/', target), true, target);
  }
  assert.equal(matchPath('src', 'src/a.ts'), false);
});

test('every other metacharacter is literal in a path pattern', () => {
  assert.equal(matchPath('docs/a.md', 'docs/aXmd'), false);
  assert.equal(matchPath('docs/[a-z].md', 'docs/a.md'), false);
  assert.equal(matchPath('docs/[a-z].md', 'docs/[a-z].md'), true);
});

test('an empty pattern and a dot match nothing a write can name', () => {
  assert.equal(matchPath('', 'src/a.ts'), false);
  assert.equal(matchPath('.', 'src/a.ts'), false);
  assert.equal(matchPath('.', ''), false);
  assert.equal(matchPath('', ''), true);
});

test('a relative, an absolute and a tilde path relativize to the same string', () => {
  const previous = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(relativeTo('src/a.ts', root), 'src/a.ts');
    assert.equal(relativeTo(path.join(root, 'src/a.ts'), root), 'src/a.ts');
    assert.equal(relativeTo('~/src/a.ts', root), 'src/a.ts');
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test('a path is normalized before it is matched', () => {
  assert.equal(relativeTo('plans/../src/a.ts', root), 'src/a.ts');
  assert.equal(matchPath('src/**', relativeTo('plans/../src/a.ts', root) as string), true);
  assert.equal(relativeTo(root, root), '');
});

test('a path outside the root relativizes to null and matches no pattern', () => {
  for (const target of ['../escape.ts', '/etc/passwd', path.join(root, '..', 'x.ts')]) {
    assert.equal(relativeTo(target, root), null, target);
  }
  for (const pattern of ['*', '**', 'src/**']) {
    assert.equal(matchPath(pattern, '../escape.ts'), pattern !== 'src/**', pattern);
  }
});
