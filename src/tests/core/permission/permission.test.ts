import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {approvalKey, decide, type Outcome} from '../../../core/permission/decide.js';

const project = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-permission-')),
);

function command(text: string): Outcome {
  return decide({kind: 'command', command: text}, project);
}

function write(target: string): Outcome {
  return decide({kind: 'write', path: target}, project);
}

const QUIET = [
  'ls -la',
  'ls',
  'pwd',
  'grep -rn TODO src',
  'rg TODO',
  'wc -l src/a.ts',
  "find . -name '*.ts'",
  'git status',
  'git log --oneline -5',
  'git diff',
  'git show HEAD',
  'git ls-files',
  'cat package.json 2>/dev/null',
  'npm test',
  'npm run build',
];

const ADVERSARIAL = [
  'ls && rm -rf ~/notes',
  'echo x > ../outside.txt',
  'cat ~/.ssh/id_rsa',
  'git push --force',
  'sudo rm -rf /',
  'env FOO=1 timeout 5 sudo ls',
  'rm -rf "$(echo src)"',
];

test('known reads run without review', () => {
  for (const text of QUIET) {
    assert.equal(command(text).decision, 'allow', text);
  }
});

test('approved git reads run with external diff disabled', () => {
  assert.equal(command('git diff').command, 'git diff --no-ext-diff');
  assert.equal(command('git log -1').command, 'git log --no-ext-diff -1');
  assert.equal(command('git show HEAD').command, 'git show --no-ext-diff HEAD');
  assert.equal(
    command('git diff --no-ext-diff').command,
    'git diff --no-ext-diff',
  );
  assert.equal(command('git status').command, 'git status');
  assert.equal(
    command('ls && git show HEAD').command,
    'ls && git show --no-ext-diff HEAD',
  );
});

test('a command that leaves the project is reviewed every time', () => {
  const outcome = command('rm ../build.log');

  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.reason, "'../build.log' is outside the project");
  assert.equal(outcome.suppressible, false);
});

test('a guardrail is never remembered even when asked to', () => {
  const guardrails = [
    'sudo ls',
    'sudo rm -rf /',
    'env FOO=1 timeout 5 sudo ls',
    'git push',
    'git push --force origin main',
    'dd of=/dev/disk0',
    'mkfs.ext4 /dev/disk1',
  ];

  for (const text of guardrails) {
    const outcome = command(text);
    assert.equal(outcome.decision, 'ask', text);
    assert.equal(outcome.suppressible, false, text);
  }
});

test('approving one command does not approve another', () => {
  assert.notEqual(
    approvalKey({kind: 'command', command: 'rm build.log'}),
    approvalKey({kind: 'command', command: 'rm other.log'}),
  );
  assert.notEqual(
    approvalKey({kind: 'command', command: 'git status'}),
    approvalKey({kind: 'command', command: 'git push'}),
  );
  assert.equal(
    approvalKey({kind: 'command', command: 'rm  build.log'}),
    approvalKey({kind: 'command', command: ' rm build.log '}),
  );
});

test('unknown commands are reviewed before execution', () => {
  const unknown = [
    'python3 build.py',
    'bash -lc "ls"',
    "node -e '1'",
    'npm install left-pad',
    'echo "unbalanced',
  ];

  for (const text of unknown) {
    const outcome = command(text);
    assert.equal(outcome.decision, 'ask', text);
    assert.equal(outcome.reason, 'cannot be classified from its text', text);
    assert.equal(outcome.suppressible, true, text);
  }
});

test('the prompt tells the user whether it can be remembered', () => {
  assert.equal(command('python3 build.py').suppressible, true);
  assert.equal(command('rm build.log').suppressible, true);
  assert.equal(command('echo x > .git/config').suppressible, true);
  assert.equal(command('sudo ls').suppressible, false);
  assert.equal(command('cat ~/.ssh/id_rsa').suppressible, false);
});

test('ls && rm -rf ~ is judged by its worst stage', () => {
  const escaping = command('ls && rm -rf ~/notes');
  assert.equal(escaping.decision, 'ask');
  assert.equal(escaping.suppressible, false);
  assert.match(escaping.reason, /outside the project/);

  const deleting = command('ls; rm build.log');
  assert.equal(deleting.decision, 'ask');
  assert.equal(deleting.suppressible, true);
  assert.match(deleting.reason, /deletes 'build\.log'/);

  assert.equal(command('git status | grep modified').decision, 'allow');
  assert.equal(command('grep -rn "a && b" src').decision, 'allow');
});

test('a write to a protected path asks', () => {
  const redirected = command('echo x > .git/config');
  assert.equal(redirected.decision, 'ask');
  assert.equal(redirected.suppressible, true);
  assert.match(redirected.reason, /protected path/);

  for (const target of ['.git/config', '.npmrc', '.claude/settings.json', '.zshrc']) {
    const outcome = write(target);
    assert.equal(outcome.decision, 'ask', target);
    assert.match(outcome.reason, /protected path/, target);
  }

  assert.equal(command('rm -rf .git').decision, 'ask');
});

test('a write inside the project does not ask', () => {
  const writes = [
    'echo x > src/a.ts',
    'echo x >> src/a.ts',
    'touch value.txt',
    'mkdir -p src/new',
    'cp src/a.ts src/b.ts',
    'mv src/a.ts src/b.ts',
  ];

  for (const text of writes) {
    assert.equal(command(text).decision, 'allow', text);
  }

  assert.equal(write('src/a.ts').decision, 'allow');
  assert.equal(write('notes/deep/file.md').decision, 'allow');
});

test('a delete inside the project asks and can be remembered', () => {
  const removing = command('rm build.log');
  assert.equal(removing.decision, 'ask');
  assert.equal(removing.suppressible, true);
  assert.match(removing.reason, /deletes 'build\.log'/);

  const finding = command('find . -name "*.log" -delete');
  assert.equal(finding.decision, 'ask');
  assert.equal(finding.suppressible, true);

  assert.equal(command('rm -rf .').suppressible, false);
});

test('adversarial commands ask and never offer to be remembered', () => {
  for (const text of ADVERSARIAL) {
    const outcome = command(text);
    assert.equal(outcome.decision, 'ask', text);
    assert.equal(outcome.suppressible, false, text);
    assert.notEqual(outcome.reason, '', text);
  }
});

test('a write outside the project asks and cannot be remembered', () => {
  const outcome = write('../outside.txt');

  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.suppressible, false);
  assert.match(outcome.reason, /outside the project/);
});
