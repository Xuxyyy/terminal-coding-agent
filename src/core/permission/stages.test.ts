import assert from 'node:assert/strict';
import test from 'node:test';
import {
  basename,
  commandParts,
  discardNoiseRedirects,
  splitStages,
  stripWrappers,
  tokenize,
} from './stages.js';

function texts(command: string): string[] {
  const stages = splitStages(command);
  assert.notEqual(stages, null, command);
  return (stages ?? []).map((stage) => stage.text.trim());
}

test('a command without separators is one stage', () => {
  assert.deepEqual(texts('git status'), ['git status']);
});

test('stages split on every shell separator', () => {
  assert.deepEqual(texts('ls && rm -rf .'), ['ls', 'rm -rf .']);
  assert.deepEqual(texts('ls || true'), ['ls', 'true']);
  assert.deepEqual(texts('ls; rm a'), ['ls', 'rm a']);
  assert.deepEqual(texts('git status | grep modified'), ['git status', 'grep modified']);
  assert.deepEqual(texts('make |& tee log'), ['make', 'tee log']);
  assert.deepEqual(texts('sleep 1 & ls'), ['sleep 1', 'ls']);
  assert.deepEqual(texts('ls\nrm a'), ['ls', 'rm a']);
  assert.deepEqual(texts('ls\r\nrm a'), ['ls', 'rm a']);
  assert.deepEqual(texts('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
});

test('a separator inside quotes does not split', () => {
  assert.deepEqual(texts('grep -rn "a && b" src'), ['grep -rn "a && b" src']);
  assert.deepEqual(texts("grep -rn 'a; b' src"), ["grep -rn 'a; b' src"]);
  assert.deepEqual(texts('echo "a | b"'), ['echo "a | b"']);
});

test('an escaped separator does not split', () => {
  assert.deepEqual(texts('echo a\\;b'), ['echo a\\;b']);
  assert.deepEqual(texts('echo "a \\" b; c"'), ['echo "a \\" b; c"']);
});

test('a redirect that looks like a separator does not split', () => {
  assert.deepEqual(texts('ls 2>&1'), ['ls 2>&1']);
  assert.deepEqual(texts('ls &> out.txt'), ['ls &> out.txt']);
  assert.deepEqual(texts('ls 2>&1 | wc -l'), ['ls 2>&1', 'wc -l']);
});

test('a heredoc body does not split', () => {
  const stages = texts("cat <<'EOF' > out.txt\na && b\nEOF\nls");

  assert.equal(stages.length, 2);
  assert.match(stages[0], /a && b/);
  assert.equal(stages[1], 'ls');
});

test('an indented heredoc ends at its tab-stripped delimiter', () => {
  const stages = texts('cat <<-EOF\n\tbody\n\tEOF\nrm a');

  assert.equal(stages.length, 2);
  assert.equal(stages[1], 'rm a');
});

test('an unbalanced quote cannot be split', () => {
  assert.equal(splitStages('echo "hello'), null);
  assert.equal(splitStages("echo 'hello"), null);
});

test('the separators are kept so the command can be rebuilt', () => {
  for (const command of [
    'ls && rm -rf .',
    'ls 2>&1 | wc -l',
    'a && b || c; d | e',
    "cat <<'EOF' > out.txt\na && b\nEOF\nls",
  ]) {
    const rebuilt = (splitStages(command) ?? [])
      .map((stage) => stage.text + stage.separator)
      .join('');
    assert.equal(rebuilt, command);
  }
});

test('tokenize splits on whitespace', () => {
  assert.deepEqual(tokenize('ls -la'), ['ls', '-la']);
  assert.deepEqual(tokenize('  git   status  '), ['git', 'status']);
  assert.deepEqual(tokenize(''), []);
});

test('tokenize keeps quoted spaces in one token and drops the quotes', () => {
  assert.deepEqual(tokenize('grep -rn "a && b" src'), ['grep', '-rn', 'a && b', 'src']);
  assert.deepEqual(tokenize("echo 'a b'"), ['echo', 'a b']);
  assert.deepEqual(tokenize('echo ""'), ['echo', '']);
  assert.deepEqual(tokenize('echo a"b"c'), ['echo', 'abc']);
});

test('tokenize handles a backslash escape', () => {
  assert.deepEqual(tokenize('echo a\\ b'), ['echo', 'a b']);
  assert.deepEqual(tokenize('echo "a \\" b"'), ['echo', 'a " b']);
});

test('tokenize keeps a substitution as one token', () => {
  assert.deepEqual(tokenize('rm -rf "$(echo src)"'), ['rm', '-rf', '$(echo src)']);
});

test('an unbalanced quote does not tokenize', () => {
  assert.equal(tokenize('echo "hello'), null);
  assert.equal(tokenize("echo 'hello"), null);
  assert.equal(tokenize('echo trailing\\'), null);
});

test('environment assignments are skipped', () => {
  assert.deepEqual(stripWrappers(['FOO=1', 'ls', '-la']), ['ls', '-la']);
  assert.deepEqual(stripWrappers(['FOO=1', 'BAR=2', 'npm', 'test']), ['npm', 'test']);
});

test('an assignment with no command after it is left alone', () => {
  assert.deepEqual(stripWrappers(['FOO=1', 'BAR=2']), ['FOO=1', 'BAR=2']);
});

test('wrappers are skipped to find the real executable', () => {
  assert.deepEqual(stripWrappers(['env', 'FOO=1', 'sudo', 'ls']), ['sudo', 'ls']);
  assert.deepEqual(stripWrappers(['nice', '-n', '10', 'npm', 'test']), ['npm', 'test']);
  assert.deepEqual(stripWrappers(['nohup', 'make']), ['make']);
  assert.deepEqual(stripWrappers(['/usr/bin/env', 'ls']), ['ls']);
  assert.deepEqual(
    stripWrappers(['env', 'FOO=1', 'timeout', '5', 'sudo', 'ls']),
    ['sudo', 'ls'],
  );
});

test('timeout skips its duration', () => {
  assert.deepEqual(stripWrappers(['timeout', '5', 'rm', 'a']), ['rm', 'a']);
  assert.deepEqual(stripWrappers(['timeout', '-k', '1', '30s', 'rm', 'a']), ['rm', 'a']);
});

test('a wrapper with nothing after it is left alone', () => {
  assert.deepEqual(stripWrappers(['env']), ['env']);
  assert.deepEqual(stripWrappers(['timeout', '-s', 'TERM']), ['timeout', '-s', 'TERM']);
});

test('xargs with an option is left alone', () => {
  assert.deepEqual(stripWrappers(['xargs', '-0', 'rm']), ['xargs', '-0', 'rm']);
  assert.deepEqual(stripWrappers(['xargs', 'rm', '-rf']), ['rm', '-rf']);
});

test('noise redirects are discarded before the command is read', () => {
  assert.equal(discardNoiseRedirects('cat package.json 2>/dev/null'), 'cat package.json');
  assert.equal(discardNoiseRedirects('ls 2>&1'), 'ls');
  assert.equal(discardNoiseRedirects('make > /dev/null 2>&1'), 'make');
  assert.equal(discardNoiseRedirects('echo x > out.txt'), 'echo x > out.txt');
});

test('basename reads the executable out of a path', () => {
  assert.equal(basename('/usr/bin/sudo'), 'sudo');
  assert.equal(basename('ls'), 'ls');
  assert.equal(basename('./scripts/build.sh'), 'build.sh');
});

test('commandParts discards noise, tokenizes, and strips wrappers', () => {
  assert.deepEqual(commandParts('cat package.json 2>/dev/null'), ['cat', 'package.json']);
  assert.deepEqual(commandParts('env FOO=1 timeout 5 sudo ls'), ['sudo', 'ls']);
  assert.equal(commandParts('echo "hello'), null);
});
