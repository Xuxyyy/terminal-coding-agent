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

test('an angle bracket inside quotes is not a redirect', () => {
  for (const command of [
    "node -e 'a=>b'",
    "node -e 'xs.map(x => x.y)'",
    'python3 -c "print(1 > 0)"',
  ]) {
    assert.equal(level(command), null, command);
  }
  assert.equal(level('grep -rn "=>" src'), 'observe');
  assert.equal(level("grep '<div>' src"), 'observe');
});

test('an angle bracket the shell would act on is still a redirect', () => {
  assert.equal(level('echo a=>b'), 'recoverable');
  assert.equal(level('echo a=>../out.txt'), 'escape');
  assert.equal(level("echo 'hi' > src/a.ts"), 'recoverable');
});

test('a quoted redirect target is judged by the name the shell uses', () => {
  for (const command of [
    'echo x > "/etc/passwd"',
    "echo x > '/etc/passwd'",
    'echo x > ""/etc/passwd',
    'echo x > \\/etc/passwd',
    'echo x >> "/etc/passwd"',
    'echo x 2> "/etc/passwd"',
    'echo x > "../out.txt"',
    "echo x > '~/.zshrc'",
    `cat secret > "${outside}/f.txt"`,
  ]) {
    assert.equal(level(command), 'escape', command);
  }
  assert.equal(level('echo x > ".git/config"'), 'protected');
  assert.equal(level('echo x > "src/a.ts"'), 'recoverable');
  assert.equal(level("echo x > 'src/a.ts'"), 'recoverable');
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
  const linked = path.join(os.tmpdir(), 'coding-cli-classify-link');
  fs.rmSync(linked, {force: true});
  fs.symlinkSync(project, linked);
  assert.notEqual(linked, realPath(linked));
  assert.equal(classifyCommand('touch value.txt', linked).level, 'recoverable');
  assert.equal(
    classifyCommand('touch value.txt', realPath(linked)).level,
    'recoverable',
  );
});

test('exact version queries for known tools only observe', () => {
  for (const command of [
    'node --version', 'node -v', 'npm --version', 'npm -v', 'pnpm --version', 'pnpm -v',
    'yarn --version', 'yarn -v', 'bun --version', 'bun -v', 'deno --version', 'deno -V',
    'python --version', 'python -V', 'python3 --version', 'python3 -V', 'python3 -VV',
    'bash --version', 'zsh --version', 'git --version', 'git -v', 'tsc --version', 'tsc -v',
    'rustc --version', 'rustc -V', 'cargo --version', 'cargo -V', 'go version',
    'node "--version" 2>/dev/null', 'command node --version',
  ]) assert.equal(level(command), 'observe', command);
});

test('a version flag does not approve unknown programs or extra execution arguments', () => {
  for (const command of [
    'custom --version', './scripts/node --version', '/usr/bin/node --version',
    'node --version script.js', 'node -v -e "1"', 'python3 -V build.py',
    'bash --version -c "ls"', 'npm --version install', 'go version ./program',
    'command python3 -v build.py', 'command -p python3 -v build.py',
  ]) assert.equal(level(command), null, command);
});

test('lookups observe names without treating them as executed commands', () => {
  for (const command of [
    'which node npm', 'which -a node', 'which -s node', 'type node', 'type -ap node',
    'type -t sudo', 'type -P rm', 'command -v node npm', 'command -V sudo',
    'command -pv rm node', 'command -p -v sudo', 'command -v -- sudo',
    'command -v git diff', 'command -v sudo --literal-name',
    'builtin command -v sudo', 'builtin type -a node', 'command which -a node',
  ]) assert.equal(level(command), 'observe', command);
  assert.equal(level('command -v sudo && sudo ls'), 'escape');
  assert.equal(level('command -v node && python3 build.py'), null);
  assert.equal(level('command -v --unexpected sudo'), 'escape');
  assert.equal(level('which --unknown node'), null);
  assert.equal(level('command -v /tmp/outside-tool'), 'escape');
});

test('metadata queries and plain output only observe', () => {
  for (const command of [
    'stat package.json', 'stat -L package.json', 'file package.json', 'file -bI package.json',
    'file --mime-type package.json', 'file -F "/separator" package.json', 'uname -as',
    'uname --machine', "printf '%s\\n' /tmp/literal", 'printf -- "-v"',
    'echo /etc/literal', 'true', 'false', 'test -f package.json',
    'test "../literal" = "../literal"',
    process.platform === 'darwin' ? "stat -f '%N/%z' package.json" : "stat --format='%n/%s' package.json",
  ]) assert.equal(level(command), 'observe', command);
});

test('formats and patterns are separate from file inputs', () => {
  for (const command of [
    'rg -e "../pattern" src', 'rg -ne../pattern src', 'rg --regexp=../pattern src',
    'rg -e "-f" src', 'rg -- ../pattern src', 'grep -rn ../pattern src',
    'grep -e../pattern src', 'grep --regexp ../pattern src', 'rg -f patterns.txt src',
    'grep -nfpatterns.txt src', 'find . -name "../pattern"', 'find . -path "*/../*"',
    'sort -t / package.json', 'diff -I ../pattern a.txt b.txt',
    'head -n3 package.json', 'tail --lines=3 package.json', 'rg --files -g "*.ts" src',
  ]) assert.equal(level(command), 'observe', command);
});

test('file inputs in separate, attached, and long options cannot leave the root', () => {
  for (const command of [
    'rg -f ../patterns src', 'rg -nf../patterns src', 'rg --file=/tmp/pattern src',
    'grep --file="../patterns" src', 'rg --ignore-file=../ignore TODO src',
    'grep --exclude-from=../ignore TODO src', 'diff --from-file=../a b',
    'find . -newer ../reference', 'sort --random-source=../random package.json',
    'file -m ../magic package.json', 'file --magic-file=local:/tmp/magic package.json',
    'stat ../outside', 'file ../outside', 'cat -- ../outside', 'test -f ../outside',
    'diff --context ../a b', 'diff --unified ../a b', 'ls -T ../outside', 'ls -w ../outside',
    process.platform === 'darwin' ? 'ls -I ../outside' : 'ls -w80 ../outside',
    'rg --pre=../hook TODO src',
  ]) assert.equal(level(command), 'escape', command);
  assert.equal(level('rg --file=link/pattern src'), 'escape');
  assert.equal(level('file --magic-file=link/magic package.json'), 'escape');
});

test('attached output options retain write and outside protections', () => {
  for (const option of ['-oout.txt', '-roout.txt', '--output=out.txt']) {
    assert.equal(level(`sort ${option} in.txt`), 'recoverable', option);
  }
  for (const option of ['-o../out.txt', '-ro../out.txt', '--output=../out.txt', '-T../tmp']) {
    assert.equal(level(`sort ${option} in.txt`), 'escape', option);
  }
  assert.equal(level('sort -o.git/config in.txt'), 'protected');
  assert.equal(level('node --version > .git/config'), 'protected');
  assert.equal(level('command -v node > ../out.txt'), 'escape');
  assert.equal(level('node --version > /dev/null.extra'), 'escape');
  assert.equal(level('file package.json 2>/dev/stderr-extra'), 'escape');
  assert.equal(level(`node --version > "${outside}/out with spaces.txt"`), 'escape');
  assert.equal(level('node --version > "out with spaces.txt"'), 'recoverable');
  assert.equal(level('node --version > out*.txt'), null);
  fs.symlinkSync(outside, path.join(project, 'outside alias'));
  assert.equal(level('node --version > "outside alias/out.txt"'), 'escape');
});

test('unsafe, indirect, and uncertain forms stay unclassified', () => {
  for (const command of [
    'file -C -m magic', 'file --compile --magic-file=magic', 'file -z archive.gz',
    'file --no-sandbox package.json', 'file --files-from=list.txt',
    'sort --files0-from=list.txt', 'wc --files0-from=list.txt',
    'sort --compress-program=./hook in.txt', 'git diff --textconv',
    'rg --search-zip TODO', 'rg --unknown TODO src', 'stat --unknown package.json',
    'printf -v RESULT text', "printf '%n' PATH", 'command -v "$(evil)"',
    'echo "$(evil)"', 'printf "%s" "$(evil)"', 'cat src/*.txt',
    'nohup node --version', 'time -o ../log node --version',
    'env --chdir=/tmp node --version', 'PATH=./scripts node --version',
    'xargs node --version', 'cd', 'cd -',
    'stat ~another-user/file',
    'rg --file=link/../patterns src', 'file -m link/../magic package.json',
    'sort -olink/../out.txt in.txt',
  ]) assert.equal(level(command), null, command);
});

test('combined observation stages keep the worst classification', () => {
  for (const command of [
    'node --version && command -v npm', 'command -v missing || true',
    'node --version | grep -e ../pattern', 'node --version |& wc -l',
    'which node; uname -s', 'which node\nstat package.json', 'true & node --version',
    "printf '%s\\n' 'a && b' | head -n1",
  ]) assert.equal(level(command), 'observe', command);
  assert.equal(level('node --version && python3 build.py'), null);
  assert.equal(level('node --version; rm build.log'), 'destroy');
  assert.equal(level('node --version && cat ../outside'), 'escape');
});

test('reads follow a known cd and uncertain later branches remain checked', () => {
  fs.mkdirSync(path.join(project, 'observed-dir'));
  fs.symlinkSync(outside, path.join(project, 'observed-dir', 'outside-link'));
  fs.symlinkSync('observed-dir', path.join(project, 'observed-alias'));
  assert.equal(level('cd observed-dir && stat local.txt'), 'observe');
  assert.equal(level('cd observed-dir && stat outside-link/file'), 'escape');
  assert.equal(level('cd observed-dir && cat ../package.json'), 'observe');
  assert.equal(level('cd observed-dir; stat local.txt'), null);
  assert.equal(level('cd observed-dir && false || stat local.txt'), null);
  assert.equal(level('cd observed-dir | stat local.txt'), null);
  assert.equal(level('true || cd observed-dir && stat local.txt'), null);
  assert.equal(level('true | cd observed-dir && stat local.txt'), null);
  assert.equal(level('true |& cd observed-dir && stat local.txt'), null);
  assert.equal(level('true || cd observed-dir && stat link/file'), 'escape');
  assert.equal(level('true | cd observed-dir && stat link/file'), 'escape');
  assert.equal(level('cd observed-dir; node --version'), 'observe');
  assert.equal(level('cd observed-alias && stat local.txt'), null);
  assert.equal(level('cd -P observed-alias/.. && stat local.txt'), null);
  assert.equal(level('cd observed-dir && rm .'), 'escape');
  assert.equal(level('cd observed-dir && rm ..'), 'escape');
  assert.equal(level('cd observed-dir && touch ../file'), 'escape');
});
