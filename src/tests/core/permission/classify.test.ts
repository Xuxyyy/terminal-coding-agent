import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {classifyCommand, classifyWrite, type Level} from '../../../core/permission/classify.js';
import {isProtectedPath, realPath} from '../../../core/permission/protected.js';

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-classify-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-outside-'));

function level(command: string): Level | null {
  return classifyCommand(command, project).level;
}

function reason(command: string): string {
  return classifyCommand(command, project).reason;
}

test('reads inside the project only observe', () => {
  for (const command of [
    'ls -la',
    'pwd',
    'cat package.json',
    'cat package.json 2>/dev/null',
    'grep -rn TODO src',
    'find . -name "*.ts"',
    'git status',
    'git log --oneline -5',
    'git diff --no-ext-diff',
    'cd src && ls',
    'git status | grep modified',
  ]) {
    assert.equal(level(command), 'observe', command);
  }
});

test('writes inside the project are the write level', () => {
  for (const command of [
    'echo x > src/a.ts',
    'echo x >> src/a.ts',
    'touch value.txt',
    'mkdir -p src/new',
    'cp src/a.ts src/b.ts',
    'mv src/a.ts src/b.ts',
    'tee out.txt',
  ]) {
    assert.equal(level(command), 'recoverable', command);
  }
});

test('a path that does not exist yet still resolves inside the project', () => {
  assert.equal(level('touch a/b/c/deep.txt'), 'recoverable');
  assert.equal(classifyWrite('a/b/c/deep.txt', project).level, 'recoverable');
});

test('protected paths are their own level', () => {
  assert.equal(level('echo x > .git/config'), 'protected');
  assert.equal(level('touch .npmrc'), 'protected');
  assert.equal(level('rm -rf .git'), 'protected');
  assert.equal(classifyWrite('.claude/settings.json', project).level, 'protected');
  assert.match(reason('touch .npmrc'), /protected path/);
});

test('deletes inside the project are the destroy level', () => {
  assert.equal(level('rm build.log'), 'destroy');
  assert.equal(level('rmdir src/empty'), 'destroy');
  assert.equal(level('find . -name "*.log" -delete'), 'destroy');
  assert.equal(reason('rm build.log'), "deletes 'build.log', which cannot be undone");
});

test('anything outside the project escapes, reads included', () => {
  assert.equal(level('rm ../build.log'), 'escape');
  assert.equal(level('echo x > ../outside.txt'), 'escape');
  assert.equal(level('cat ~/.ssh/id_rsa'), 'escape');
  assert.equal(level(`cat ${path.join(outside, 'secret.txt')}`), 'escape');
  assert.equal(reason('rm ../build.log'), "'../build.log' is outside the project");
  assert.match(reason('cat ~/.ssh/id_rsa'), /^reads '~\/\.ssh\/id_rsa' outside the project$/);
});

test('a symlink that leaves the project escapes', () => {
  fs.symlinkSync(outside, path.join(project, 'link'));

  assert.equal(level('cat link/secret.txt'), 'escape');
  assert.equal(level('echo x > link/secret.txt'), 'escape');
  assert.equal(classifyWrite('link/secret.txt', project).level, 'escape');
});

test('escaping executables escape whatever they are hidden behind', () => {
  assert.equal(level('sudo ls'), 'escape');
  assert.equal(level('env FOO=1 timeout 5 sudo ls'), 'escape');
  assert.equal(level('git push'), 'escape');
  assert.equal(level('git push --force origin main'), 'escape');
  assert.equal(level('dd of=/dev/disk0'), 'escape');
  assert.equal(level('mkfs.ext4 /dev/disk1'), 'escape');
  assert.equal(level(':(){ :|:& };:'), 'escape');
  assert.equal(reason('sudo ls'), 'sudo');
});

test('a write target that cannot be determined escapes', () => {
  assert.equal(level('rm -rf "$(echo src)"'), 'escape');
  assert.equal(level('echo x > `date`.txt'), 'escape');
  assert.equal(
    reason('rm -rf "$(echo src)"'),
    'writes to a target that cannot be determined',
  );
});

test('the project root itself cannot be destroyed', () => {
  assert.equal(level('rm -rf .'), 'escape');
  assert.equal(level(`rm -rf ${project}`), 'escape');
  assert.match(reason('rm -rf .'), /is the project root itself/);
});

test('the worst stage decides', () => {
  assert.equal(level('ls && rm -rf ~/notes'), 'escape');
  assert.equal(level('ls; rm build.log'), 'destroy');
  assert.equal(level('ls && touch a.txt'), 'recoverable');
  assert.equal(level('ls && git status'), 'observe');
  assert.equal(level('grep -rn "a && b" src'), 'observe');
});

test('an escaping stage beats an unknown one, otherwise unknown wins', () => {
  assert.equal(level('python3 build.py && sudo ls'), 'escape');
  assert.equal(level('python3 build.py && rm build.log'), null);
  assert.equal(level('ls && python3 build.py'), null);
});

test('a command that cannot be classified has no level', () => {
  for (const command of [
    'python3 build.py',
    'bash -lc "ls"',
    "node -e '1'",
    'npm install left-pad',
    'npm publish',
    'echo "unbalanced',
    '/bin/ls',
  ]) {
    assert.equal(level(command), null, command);
  }
});

test('project runners stay inside the project', () => {
  assert.equal(level('npm test'), 'recoverable');
  assert.equal(level('npm run build'), 'recoverable');
  assert.equal(level('pnpm test'), 'recoverable');
  assert.equal(level('yarn run lint'), 'recoverable');
  assert.equal(level('npm run $(evil)'), null);
  assert.equal(level('npm test > ../out.txt'), 'escape');
});

test('an unsafe option turns a read into a write', () => {
  assert.equal(level('sort -o out.txt in.txt'), 'recoverable');
  assert.equal(level('sort -o ../out.txt in.txt'), 'escape');
  assert.equal(level('git diff --ext-diff'), null);
  assert.equal(level('rg --pre ./hook TODO'), 'recoverable');
});

test('protected paths are recognised anywhere under the root', () => {
  assert.equal(isProtectedPath(path.join(project, '.git', 'config'), project), true);
  assert.equal(isProtectedPath(path.join(project, 'src', '.npmrc'), project), true);
  assert.equal(isProtectedPath(path.join(project, 'src', 'a.ts'), project), false);
  assert.equal(isProtectedPath(project, project), false);
  assert.equal(isProtectedPath(path.join(outside, 'a.ts'), project), true);
});

test('the root is compared by its real path, not the name it was given', () => {
  assert.notEqual(project, realPath(project));
  assert.equal(level('touch value.txt'), 'recoverable');
  assert.equal(classifyCommand('touch value.txt', realPath(project)).level, 'recoverable');
});
