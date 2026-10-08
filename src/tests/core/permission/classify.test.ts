import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {classifyCommand, classifyWrite, type Tier, type CheckCause} from '../../../core/permission/classify.js';
import {isProtectedPath, realPath} from '../../../core/permission/protected.js';

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-classify-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-outside-'));

// Keep checking the specific cause as well as the new permission tier.
function finding(command: string): Tier | CheckCause {
  const result = classifyCommand(command, project);
  assert.equal(result.tier === 'needs-checking', result.cause !== null, command);
  assert.deepEqual(result.restrictions, {
    mustCheck: result.cause === 'escape', onceOnly: result.cause === 'escape',
  }, command);
  return result.cause ?? result.tier;
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
    assert.equal(finding(command), 'observe', command);
  }
});

test('ordinary writes inside the project use the recoverable tier', () => {
  for (const command of [
    'echo x > src/a.ts',
    'echo x >> src/a.ts',
    'touch value.txt',
    'mkdir -p src/new',
    'cp src/a.ts src/b.ts',
    'mv src/a.ts src/b.ts',
    'tee out.txt',
  ]) {
    assert.equal(finding(command), 'recoverable', command);
  }
});

test('a path that does not exist yet still resolves inside the project', () => {
  assert.equal(finding('touch a/b/c/deep.txt'), 'recoverable');
  assert.equal(classifyWrite('a/b/c/deep.txt', project).tier, 'recoverable');
});

test('protected writes retain their check reason', () => {
  assert.equal(finding('echo x > .git/config'), 'protected');
  assert.equal(finding('touch .npmrc'), 'protected');
  assert.equal(finding('rm -rf .git'), 'protected');
  assert.equal(classifyWrite('.claude/settings.json', project).cause, 'protected');
  assert.match(reason('touch .npmrc'), /protected path/);
});

test('deletes inside the project retain the destroy check reason', () => {
  assert.equal(finding('rm build.log'), 'destroy');
  assert.equal(finding('rmdir src/empty'), 'destroy');
  assert.equal(finding('find . -name "*.log" -delete'), 'destroy');
  assert.equal(reason('rm build.log'), "deletes 'build.log', which cannot be undone");
});

test('anything outside the project escapes, reads included', () => {
  assert.equal(finding('rm ../build.log'), 'escape');
  assert.equal(finding('echo x > ../outside.txt'), 'escape');
  assert.equal(finding('cat ~/.ssh/id_rsa'), 'escape');
  assert.equal(finding(`cat ${path.join(outside, 'secret.txt')}`), 'escape');
  assert.equal(reason('rm ../build.log'), "'../build.log' is outside the project");
  assert.match(reason('cat ~/.ssh/id_rsa'), /^reads '~\/\.ssh\/id_rsa' outside the project$/);
});

test('a symlink that leaves the project escapes', () => {
  fs.symlinkSync(outside, path.join(project, 'link'));

  assert.equal(finding('cat link/secret.txt'), 'escape');
  assert.equal(finding('echo x > link/secret.txt'), 'escape');
  assert.equal(classifyWrite('link/secret.txt', project).cause, 'escape');
});

test('escaping executables escape whatever they are hidden behind', () => {
  assert.equal(finding('sudo ls'), 'escape');
  assert.equal(finding('env FOO=1 timeout 5 sudo ls'), 'escape');
  assert.equal(finding('git push'), 'escape');
  assert.equal(finding('git push --force origin main'), 'escape');
  assert.equal(finding('dd of=/dev/disk0'), 'escape');
  assert.equal(finding('mkfs.ext4 /dev/disk1'), 'escape');
  assert.equal(finding(':(){ :|:& };:'), 'escape');
  assert.equal(reason('sudo ls'), 'sudo');
});

test('a write target that cannot be determined escapes', () => {
  assert.equal(finding('rm -rf "$(echo src)"'), 'escape');
  assert.equal(finding('echo x > `date`.txt'), 'escape');
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
    assert.equal(finding(command), 'unknown', command);
  }
  assert.equal(finding('grep -rn "=>" src'), 'observe');
  assert.equal(finding("grep '<div>' src"), 'observe');
});

test('an angle bracket the shell would act on is still a redirect', () => {
  assert.equal(finding('echo a=>b'), 'recoverable');
  assert.equal(finding('echo a=>../out.txt'), 'escape');
  assert.equal(finding("echo 'hi' > src/a.ts"), 'recoverable');
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
    assert.equal(finding(command), 'escape', command);
  }
  assert.equal(finding('echo x > ".git/config"'), 'protected');
  assert.equal(finding('echo x > "src/a.ts"'), 'recoverable');
  assert.equal(finding("echo x > 'src/a.ts'"), 'recoverable');
});

test('the project root itself cannot be destroyed', () => {
  assert.equal(finding('rm -rf .'), 'escape');
  assert.equal(finding(`rm -rf ${project}`), 'escape');
  assert.match(reason('rm -rf .'), /is the project root itself/);
});

test('the worst stage decides', () => {
  assert.equal(finding('ls && rm -rf ~/notes'), 'escape');
  assert.equal(finding('ls; rm build.log'), 'destroy');
  assert.equal(finding('ls && touch a.txt'), 'recoverable');
  assert.equal(finding('ls && git status'), 'observe');
  assert.equal(finding('grep -rn "a && b" src'), 'observe');
});

test('an escaping stage beats an unknown one, otherwise unknown wins', () => {
  assert.equal(finding('python3 build.py && sudo ls'), 'escape');
  assert.equal(finding('python3 build.py && rm build.log'), 'unknown');
  assert.equal(finding('ls && python3 build.py'), 'unknown');
});

test('a command with unknown effects needs checking', () => {
  for (const command of [
    'python3 build.py',
    'bash -lc "ls"',
    "node -e '1'",
    'npm install left-pad',
    'npm publish',
    'echo "unbalanced',
    '/bin/ls',
  ]) {
    assert.equal(finding(command), 'unknown', command);
  }
});

test('project runners stay inside the project', () => {
  assert.equal(finding('npm test'), 'recoverable');
  assert.equal(finding('npm run build'), 'recoverable');
  assert.equal(finding('pnpm test'), 'recoverable');
  assert.equal(finding('yarn run lint'), 'recoverable');
  assert.equal(finding('npm run $(evil)'), 'unknown');
  assert.equal(finding('npm test > ../out.txt'), 'escape');
});

test('an unsafe option turns a read into a write', () => {
  assert.equal(finding('sort -o out.txt in.txt'), 'recoverable');
  assert.equal(finding('sort -o ../out.txt in.txt'), 'escape');
  assert.equal(finding('git diff --ext-diff'), 'unknown');
  assert.equal(finding('rg --pre ./hook TODO'), 'unknown');
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
  assert.equal(classifyCommand('touch value.txt', linked).tier, 'recoverable');
  assert.equal(
    classifyCommand('touch value.txt', realPath(linked)).tier,
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
  ]) assert.equal(finding(command), 'observe', command);
});

test('a version flag does not approve unknown programs or extra execution arguments', () => {
  for (const command of [
    'custom --version', './scripts/node --version', '/usr/bin/node --version',
    'node --version script.js', 'node -v -e "1"', 'python3 -V build.py',
    'bash --version -c "ls"', 'npm --version install', 'go version ./program',
    'command python3 -v build.py', 'command -p python3 -v build.py',
  ]) assert.equal(finding(command), 'unknown', command);
});

test('lookups observe names without treating them as executed commands', () => {
  for (const command of [
    'which node npm', 'which -a node', 'which -s node', 'type node', 'type -ap node',
    'type -t sudo', 'type -P rm', 'command -v node npm', 'command -V sudo',
    'command -pv rm node', 'command -p -v sudo', 'command -v -- sudo',
    'command -v git diff', 'command -v sudo --literal-name',
    'builtin command -v sudo', 'builtin type -a node', 'command which -a node',
  ]) assert.equal(finding(command), 'observe', command);
  assert.equal(finding('command -v sudo && sudo ls'), 'escape');
  assert.equal(finding('command -v node && python3 build.py'), 'unknown');
  assert.equal(finding('command -v --unexpected sudo'), 'escape');
  assert.equal(finding('which --unknown node'), 'unknown');
  assert.equal(finding('command -v /tmp/outside-tool'), 'escape');
});

test('metadata queries and plain output only observe', () => {
  for (const command of [
    'stat package.json', 'stat -L package.json', 'file package.json', 'file -bI package.json',
    'file --mime-type package.json', 'file -F "/separator" package.json', 'uname -as',
    'uname --machine', "printf '%s\\n' /tmp/literal", 'printf -- "-v"',
    'echo /etc/literal', 'true', 'false', 'test -f package.json',
    'test "../literal" = "../literal"',
    process.platform === 'darwin' ? "stat -f '%N/%z' package.json" : "stat --format='%n/%s' package.json",
  ]) assert.equal(finding(command), 'observe', command);
});

test('formats and patterns are separate from file inputs', () => {
  for (const command of [
    'rg -e "../pattern" src', 'rg -ne../pattern src', 'rg --regexp=../pattern src',
    'rg -e "-f" src', 'rg -- ../pattern src', 'grep -rn ../pattern src',
    'grep -e../pattern src', 'grep --regexp ../pattern src', 'rg -f patterns.txt src',
    'grep -nfpatterns.txt src', 'find . -name "../pattern"', 'find . -path "*/../*"',
    'sort -t / package.json', 'diff -I ../pattern a.txt b.txt',
    'head -n3 package.json', 'tail --lines=3 package.json', 'rg --files -g "*.ts" src',
  ]) assert.equal(finding(command), 'observe', command);
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
  ]) assert.equal(finding(command), 'escape', command);
  assert.equal(finding('rg --file=link/pattern src'), 'escape');
  assert.equal(finding('file --magic-file=link/magic package.json'), 'escape');
});

test('attached output options retain write and outside protections', () => {
  for (const option of ['-oout.txt', '-roout.txt', '--output=out.txt']) {
    assert.equal(finding(`sort ${option} in.txt`), 'recoverable', option);
  }
  for (const option of ['-o../out.txt', '-ro../out.txt', '--output=../out.txt', '-T../tmp']) {
    assert.equal(finding(`sort ${option} in.txt`), 'escape', option);
  }
  assert.equal(finding('sort -o.git/config in.txt'), 'protected');
  assert.equal(finding('node --version > .git/config'), 'protected');
  assert.equal(finding('command -v node > ../out.txt'), 'escape');
  assert.equal(finding('node --version > /dev/null.extra'), 'escape');
  assert.equal(finding('file package.json 2>/dev/stderr-extra'), 'escape');
  assert.equal(finding(`node --version > "${outside}/out with spaces.txt"`), 'escape');
  assert.equal(finding('node --version > "out with spaces.txt"'), 'recoverable');
  assert.equal(finding('node --version > out*.txt'), 'unknown');
  fs.symlinkSync(outside, path.join(project, 'outside alias'));
  assert.equal(finding('node --version > "outside alias/out.txt"'), 'escape');
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
  ]) assert.equal(finding(command), 'unknown', command);
});

test('combined observation stages keep the worst classification', () => {
  for (const command of [
    'node --version && command -v npm', 'command -v missing || true',
    'node --version | grep -e ../pattern', 'node --version |& wc -l',
    'which node; uname -s', 'which node\nstat package.json', 'true & node --version',
    "printf '%s\\n' 'a && b' | head -n1",
  ]) assert.equal(finding(command), 'observe', command);
  assert.equal(finding('node --version && python3 build.py'), 'unknown');
  assert.equal(finding('node --version; rm build.log'), 'destroy');
  assert.equal(finding('node --version && cat ../outside'), 'escape');
});

test('reads follow a known cd and uncertain later branches remain checked', () => {
  fs.mkdirSync(path.join(project, 'observed-dir'));
  fs.symlinkSync(outside, path.join(project, 'observed-dir', 'outside-link'));
  fs.symlinkSync('observed-dir', path.join(project, 'observed-alias'));
  assert.equal(finding('cd observed-dir && stat local.txt'), 'observe');
  assert.equal(finding('cd observed-dir && stat outside-link/file'), 'escape');
  assert.equal(finding('cd observed-dir && cat ../package.json'), 'observe');
  assert.equal(finding('cd observed-dir; stat local.txt'), 'unknown');
  assert.equal(finding('cd observed-dir && false || stat local.txt'), 'unknown');
  assert.equal(finding('cd observed-dir | stat local.txt'), 'unknown');
  assert.equal(finding('true || cd observed-dir && stat local.txt'), 'unknown');
  assert.equal(finding('true | cd observed-dir && stat local.txt'), 'unknown');
  assert.equal(finding('true |& cd observed-dir && stat local.txt'), 'unknown');
  assert.equal(finding('true || cd observed-dir && stat link/file'), 'escape');
  assert.equal(finding('true | cd observed-dir && stat link/file'), 'escape');
  assert.equal(finding('cd observed-dir; node --version'), 'observe');
  assert.equal(finding('cd observed-alias && stat local.txt'), 'unknown');
  assert.equal(finding('cd -P observed-alias/.. && stat local.txt'), 'unknown');
  assert.equal(finding('cd observed-dir && rm .'), 'escape');
  assert.equal(finding('cd observed-dir && rm ..'), 'escape');
  assert.equal(finding('cd observed-dir && touch ../file'), 'escape');
});

test('write options distinguish values, file inputs, and destinations', () => {
  for (const command of [
    'cp -iv src/a.ts src/b.ts', 'cp -t src/dest src/a.ts', 'cp -vtsrc/dest src/a.ts',
    'cp --target-directory=src/dest src/a.ts src/b.ts', 'cp -T src/a.ts src/b.ts',
    'mv -ntsrc/dest src/a.ts', 'ln -stsrc/dest ../a.ts',
    'mkdir -pm755 src/new', 'mkdir --mode=u=rwx,g=rx,o=rx src/new',
    'touch -acr.git/config value.txt', 'touch --reference=.git/config value.txt',
    'touch -d "../not a file" value.txt', 'touch --date=../literal value.txt',
    'touch -t202610071200 value.txt', 'tee -ai out.txt', 'tee --output-error=warn out.txt',
    'touch -- -file.txt', 'cp -- -input.txt -output.txt',
    'cp .git/config copied-config', 'cp .npmrc copied-config',
  ]) assert.equal(finding(command), 'recoverable', command);
  for (const command of [
    'cp -t../outside src/a.ts', 'cp --target-directory=../outside src/a.ts',
    'mv -vt../outside src/a.ts', 'ln -st../outside a.ts', 'touch -ar../reference out.txt',
    'touch --reference=link/reference out.txt', 'cp ../input src/output',
    'cp link/input src/output', 'mv link/input src/output',
  ]) assert.equal(finding(command), 'escape', command);
  for (const command of [
    'cp -t.git src/a.ts', 'mv .git/config copied-config', 'ln .git/config config-alias',
    'ln -s .git/config config-alias', 'touch .npmrc',
  ]) assert.equal(finding(command), 'protected', command);
});

test('unknown write options and unsafe execution forms remain checked', () => {
  for (const command of [
    'cp --unknown src/a.ts src/b.ts', 'cp -Z src/a.ts src/b.ts',
    'cp -t', 'cp -t first -t second src/a.ts', 'cp -T -t dest src/a.ts',
    'cp --target-directory= src/a.ts', 'cp -T a b c', 'mv --backup a b',
    'cp -l a b', 'cp -s a b', 'cp --parents a b', 'cp a',
    'touch --unknown out.txt', 'touch -r', 'mkdir --mode', 'tee --unknown out.txt',
    'sort --unknown -o out.txt in.txt', 'sort --files0-from=list -o out.txt',
    'sort --compress-program=hook -o out.txt in.txt',
    'python3 build.py > out.txt', 'bash -lc "touch file" > out.txt',
    'rg --pre=hook TODO > out.txt', 'env FOO=1 touch out.txt', 'xargs touch out.txt',
    'time -o../timing touch out.txt', 'nohup touch out.txt', './scripts/touch out.txt',
    '/bin/touch out.txt', 'PATH=./scripts touch out.txt',
    'env --chdir=/tmp npm test > out.txt', 'xargs npm run build > out.txt',
    './scripts/npm run build > out.txt',
    'touch src/*.ts', 'touch ~someone/file', 'touch out.txt # comment',
    'cat <<EOF > out.txt\ntext\nEOF', 'cat <<<text > out.txt', 'cat <> input > out.txt',
    'echo x >| out.txt',
  ]) assert.equal(finding(command), 'unknown', command);
  assert.equal(finding('command touch out.txt'), 'recoverable');
  assert.equal(finding('command -p touch out.txt'), 'recoverable');
  assert.equal(finding('builtin echo hello > out.txt'), 'recoverable');
  assert.equal(finding('cp --unknown a ../outside'), 'escape');
});

test('literal input and output redirects check both sides without changing arguments', () => {
  for (const command of [
    'cat src/a.ts > src/b.ts', 'cat < src/a.ts >> src/b.ts',
    'cat < .git/config > copied-config', 'cat<src/a.ts>src/b.ts',
    'echo hello &> "out file.txt"', 'printf "%s" hi &>> out.txt',
    'touch first.txt > second.txt', '>out.txt cat input.txt',
    'echo " > /dev/null " > out.txt', 'echo "a=>b" > out.txt',
    'echo a\\>b > out.txt', 'echo hi 2>out.txt 1>&2',
  ]) assert.equal(finding(command), 'recoverable', command);
  for (const command of [
    'cat < ../input > out.txt', 'cat ../input > out.txt', 'cat < link/input > out.txt',
    'cat < src/a.ts > link/output', 'echo hi &>> ../output', 'cat input > /dev/null.extra',
  ]) assert.equal(finding(command), 'escape', command);
  assert.equal(finding('cat < src/a.ts'), 'observe');
  assert.equal(finding('cat .git/config > out.txt'), 'recoverable');
  assert.equal(finding('cat src/a.ts > .git/config'), 'protected');
  assert.equal(finding('cat --unknown > out.txt'), 'unknown');
});

test('find retains deletion and explicit output guardrails without treating patterns as writes', () => {
  assert.equal(finding('find . -name -delete'), 'observe');
  assert.equal(finding('find . -name "*.log" -delete'), 'destroy');
  assert.equal(finding('find . -fprint ../output'), 'escape');
  assert.equal(finding('find . -fprintf .git/config "%p"'), 'protected');
  assert.equal(finding('find . -exec custom-script {} \\;'), 'destroy');
  assert.equal(finding('find . -fprint output'), 'unknown');
});

test('directory destinations check the files created inside them', () => {
  fs.mkdirSync(path.join(project, 'write-destination'));
  fs.symlinkSync(outside, path.join(project, 'write-destination', 'a.ts'));
  for (const command of [
    'cp src/a.ts write-destination', 'cp -twrite-destination src/a.ts',
    'mv src/a.ts write-destination', 'ln src/a.ts write-destination',
  ]) assert.equal(finding(command), 'escape', command);
  assert.equal(finding('cp .npmrc write-destination'), 'protected');
  assert.equal(finding('cp .git/config write-destination'), 'recoverable');
  assert.equal(finding('cp -T src/a.ts write-destination'), 'recoverable');
});

test('recursive copies inspect source trees and mapped destination paths', () => {
  fs.mkdirSync(path.join(project, 'copy-source', 'nested'), {recursive: true});
  fs.writeFileSync(path.join(project, 'copy-source', 'nested', 'file.txt'), 'text');
  fs.mkdirSync(path.join(project, 'copy-destination'));
  assert.equal(finding('cp -R copy-source new-copy'), 'recoverable');
  assert.equal(finding('cp -a copy-source copy-destination'), 'recoverable');
  assert.equal(finding('mv copy-source moved-copy'), 'recoverable');
  fs.mkdirSync(path.join(project, 'copy-source', '.git'));
  fs.writeFileSync(path.join(project, 'copy-source', '.git', 'config'), 'text');
  assert.equal(finding('cp -R copy-source new-copy'), 'protected');
  assert.equal(finding('mv copy-source moved-copy'), 'protected');
  fs.rmSync(path.join(project, 'copy-source', '.git'), {recursive: true});
  fs.mkdirSync(path.join(project, 'copy-destination', 'copy-source', 'nested'), {recursive: true});
  fs.symlinkSync(outside, path.join(project, 'copy-destination', 'copy-source', 'nested', 'file.txt'));
  assert.equal(finding('cp -R copy-source copy-destination'), 'escape');
  assert.equal(finding('cp -R copy-source copy-source/new-copy'), 'unknown');
  assert.equal(finding('cp -R missing-copy-source new-copy'), 'unknown');
  assert.equal(finding('cp -R copy-source new-copy > copy-source/new-file'), 'unknown');
});

test('recursive copies check symlinks before and after relocation', () => {
  fs.mkdirSync(path.join(project, 'link-tree', 'nested'), {recursive: true});
  fs.writeFileSync(path.join(project, 'reference.txt'), 'text');
  fs.symlinkSync('../../reference.txt', path.join(project, 'link-tree', 'nested', 'relative'));
  assert.equal(finding('cp -RP link-tree another-tree'), 'recoverable');
  assert.equal(finding('cp -RP link-tree/nested shallow-copy'), 'escape');
  assert.equal(finding('mv link-tree/nested/relative relocated-link'), 'escape');
  assert.equal(finding('ln -P link-tree/nested/relative physical-link'), 'escape');
  if (process.platform !== 'darwin') assert.equal(finding('cp -P link-tree/nested/relative relocated-link'), 'escape');
  fs.symlinkSync(outside, path.join(project, 'link-tree', 'outside'));
  assert.equal(finding('cp -RP link-tree another-tree'), 'escape');
  assert.equal(finding('cp -RL link-tree another-tree'), 'escape');
  fs.rmSync(path.join(project, 'link-tree', 'outside'));
  fs.symlinkSync('..', path.join(project, 'link-tree', 'nested', 'cycle'));
  assert.equal(finding('cp -RL link-tree another-tree'), 'unknown');
  fs.symlinkSync('link-tree', path.join(project, 'tree-alias'));
  assert.equal(finding('cp -RH tree-alias another-tree'), 'recoverable');
});

test('recursive trailing slashes follow the platform copy layout', () => {
  fs.mkdirSync(path.join(project, 'slash-source'));
  fs.writeFileSync(path.join(project, 'slash-source', 'file.txt'), 'text');
  fs.mkdirSync(path.join(project, 'slash-destination'));
  fs.symlinkSync(outside, path.join(project, 'slash-destination', 'file.txt'));
  assert.equal(finding('cp -R slash-source slash-destination'), 'recoverable');
  assert.equal(finding('cp -R slash-source/ slash-destination'), process.platform === 'darwin' ? 'escape' : 'recoverable');
  assert.equal(finding('cp -R slash-source/. slash-destination'), 'escape');
});

test('dangling symlinks, loops, and reference traversal remain guarded', () => {
  fs.symlinkSync(path.join(outside, 'missing'), path.join(project, 'dangling-outside'));
  fs.symlinkSync('self-cycle', path.join(project, 'self-cycle'));
  for (const command of [
    'touch dangling-outside', 'cp dangling-outside out.txt',
    'cat < dangling-outside > out.txt', 'sort -odangling-outside input.txt',
  ]) assert.equal(finding(command), 'escape', command);
  assert.equal(finding('touch self-cycle'), 'unknown');
  assert.equal(finding('touch dangling-outside/../file'), 'unknown');
  assert.equal(finding('cp -R self-cycle new-copy'), 'unknown');
  fs.mkdirSync(path.join(project, 'link-parent'));
  assert.equal(finding('ln -s ../reference.txt link-parent/alias'), 'recoverable');
  assert.equal(finding('ln -s ../../outside link-parent/alias'), 'escape');
  assert.equal(finding('ln -s ../link/../reference link-parent/alias'), 'unknown');
});

test('parent removals and filesystem changes in earlier stages remain checked', () => {
  assert.equal(finding('rmdir -p a/b/c'), 'destroy');
  assert.equal(finding('rmdir -p ./a/b/c'), 'escape');
  assert.equal(finding(`rmdir -p ${project}/a/b`), 'escape');
  assert.equal(finding('mv . other-project'), 'escape');
  assert.equal(finding('touch first.txt && touch second.txt'), 'recoverable');
  assert.equal(finding('cat input.txt | tee output.txt'), 'recoverable');
  assert.equal(finding('cat same.txt | tee same.txt'), 'unknown');
  assert.equal(finding('cat same.txt & touch same.txt'), 'unknown');
  assert.equal(finding('touch first.txt && cat first.txt'), 'unknown');
  assert.equal(finding('mkdir -p new-dir && cp input.txt new-dir'), 'unknown');
  assert.equal(finding('ln -s input.txt new-link && touch new-link'), 'unknown');
  assert.equal(finding('npm run build && cp output.txt copy.txt'), 'unknown');
  assert.equal(finding('touch first.txt && cp input.txt ../outside'), 'escape');
});

test('unreadable recursive sources stay checked', {skip: process.getuid?.() === 0}, () => {
  const directory = path.join(project, 'unreadable-copy');
  fs.mkdirSync(directory, {mode: 0o000});
  try { assert.equal(finding('cp -R unreadable-copy new-copy'), 'unknown'); }
  finally { fs.chmodSync(directory, 0o700); }
});
