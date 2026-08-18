import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {approvalKey, decide, type Outcome} from '../../../core/permission/decide.js';
import {clearSession, createSession} from '../../../core/session.js';
import type {Rules} from '../../../core/settings.js';

const project = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-permission-')),
);
const outside = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-outside-')),
);

function rules(some: Partial<Rules>): Rules {
  return {allow: [], ask: [], deny: [], ...some};
}

function command(text: string, some?: Partial<Rules>): Outcome {
  const request = {kind: 'command', command: text} as const;
  return some ? decide(request, project, rules(some)) : decide(request, project);
}

function write(target: string, some?: Partial<Rules>): Outcome {
  const request = {kind: 'write', path: target} as const;
  return some ? decide(request, project, rules(some)) : decide(request, project);
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

test('a write outside the project is denied and cannot be remembered', () => {
  const outcome = write('../outside.txt');

  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.suppressible, false);
  assert.equal(outcome.reason, "'../outside.txt' is outside the project");

  assert.equal(write(path.join(outside, 'secret.txt')).decision, 'deny');
  assert.equal(write('~/.ssh/id_rsa').decision, 'deny');
});

test('a file tool denies what bash only asks about', () => {
  const denied = write('../outside.txt');
  const asked = command('rm ../outside.txt');

  assert.equal(denied.decision, 'deny');
  assert.equal(asked.decision, 'ask');
  assert.equal(asked.suppressible, false);
  assert.equal(denied.reason, asked.reason);
});

test('an allow rule stops a command being asked about', () => {
  const outcome = command('python3 scripts/build.py', {
    allow: ['python3 scripts/*'],
  });

  assert.equal(outcome.decision, 'allow');
  assert.match(outcome.reason, /settings\.json/);
  assert.equal(outcome.command, 'python3 scripts/build.py');
});

test('a deny rule refuses a command the classifier would have run', () => {
  const outcome = command('ls', {deny: ['ls*']});

  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.suppressible, false);
  assert.match(outcome.reason, /settings\.json/);
});

test('an ask rule puts a prompt back on a quiet command', () => {
  const outcome = command('ls', {ask: ['ls*']});

  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.suppressible, true);
  assert.match(outcome.reason, /settings\.json/);
});

test('no allow rule can rescue a guardrail', () => {
  const everything = {allow: ['*']};
  const guardrails = [
    'sudo rm -rf /',
    'git push',
    'dd of=/dev/sda',
    'mkfs.ext4 /dev/sda',
    'cat ../../outside.txt',
    ':(){ :|:& };:',
  ];

  for (const text of guardrails) {
    const outcome = command(text, everything);
    assert.equal(outcome.decision, 'ask', text);
    assert.equal(outcome.suppressible, false, text);
    assert.doesNotMatch(outcome.reason, /settings\.json/, text);
  }
});

test('a deny rule can still refuse a guardrail', () => {
  const outcome = command('git push', {deny: ['git push*']});

  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.suppressible, false);
});

test('empty rules reproduce the outcomes of the classifier alone', () => {
  for (const text of [...QUIET, ...ADVERSARIAL]) {
    assert.deepEqual(command(text, {}), command(text), text);
  }
  for (const text of QUIET) {
    assert.equal(command(text, {}).decision, 'allow', text);
  }
  for (const text of ADVERSARIAL) {
    const outcome = command(text, {});
    assert.equal(outcome.decision, 'ask', text);
    assert.equal(outcome.suppressible, false, text);
  }
});

test('a rule never decides a write', () => {
  assert.equal(write('src/a.ts', {deny: ['src/*']}).decision, 'allow');
  assert.equal(write('../outside.txt', {allow: ['*']}).decision, 'deny');
});

test('clearing the conversation keeps the rules', () => {
  const session = createSession(project, 'system', 100);
  session.rules = rules({allow: ['npm run *']});
  session.allowed.add('bash ls');

  clearSession(session);

  assert.deepEqual(session.rules, rules({allow: ['npm run *']}));
  assert.equal(session.allowed.size, 0);
});
