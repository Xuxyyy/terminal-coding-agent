import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {approvalKey, decide, type Outcome, type Request} from '../../../core/permission/decide.js';
import {MODES, type Mode} from '../../../core/permission/mode.js';
import type {Host} from '../../../core/host.js';
import {clearSession, createSession, setMode, type Session} from '../../../core/session.js';
import type {Rule, Rules, Tag} from '../../../core/settings.js';
import {tools} from '../../../core/tools/index.js';
import {runTool, type Tool, type ToolContext} from '../../../core/tools/registry.js';
import {z} from 'zod';

const project = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-permission-')),
);
const outside = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-outside-')),
);

type RuleText = Partial<Record<keyof Rules, string[]>>;

const TAGGED = /^(bash|edit)\((.*)\)$/;

function ruleOf(text: string): Rule {
  const match = TAGGED.exec(text);
  return match ? {tag: match[1] as Tag, pattern: match[2]} : {tag: 'bash', pattern: text};
}

function rules(some: RuleText): Rules {
  const lists = {allow: [], ask: [], deny: [], ...some};
  return {
    allow: lists.allow.map(ruleOf),
    ask: lists.ask.map(ruleOf),
    deny: lists.deny.map(ruleOf),
  };
}

function asked(request: Request, some?: RuleText, mode?: Mode): Outcome {
  return decide(request, project, some ? rules(some) : undefined, mode);
}

function command(text: string, some?: RuleText, mode?: Mode): Outcome {
  return asked({kind: 'command', command: text}, some, mode);
}

function write(target: string, some?: RuleText, mode?: Mode): Outcome {
  return asked({kind: 'write', path: target}, some, mode);
}

function read(target: string, some?: RuleText, mode?: Mode): Outcome {
  return asked({kind: 'read', path: target}, some, mode);
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
  assert.equal(outcome.reason, "'../outside.txt' is outside the project");

  assert.equal(write(path.join(outside, 'secret.txt')).decision, 'ask');
  assert.equal(write('~/.ssh/id_rsa').decision, 'ask');
});

test('a file tool and bash answer the same for a path outside the project', () => {
  const file = write('../outside.txt');
  const bash = command('rm ../outside.txt');

  assert.equal(file.decision, bash.decision);
  assert.equal(file.suppressible, bash.suppressible);
  assert.equal(file.reason, bash.reason);
  assert.equal(file.decision, 'ask');
  assert.equal(file.suppressible, false);
});

test('a read inside the project runs without asking', () => {
  for (const target of ['src/a.ts', 'notes/deep/file.md', '.', path.join(project, 'a.ts')]) {
    const outcome = read(target);
    assert.equal(outcome.decision, 'allow', target);
    assert.equal(outcome.suppressible, true, target);
  }
});

test('a read of a protected path is still only a read', () => {
  for (const target of ['.acc/settings.json', '.git/config', '.npmrc']) {
    assert.equal(read(target).decision, 'allow', target);
  }
});

test('a read outside the project asks and names the path', () => {
  const outcome = read('~/.ssh/id_rsa');

  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.suppressible, false);
  assert.equal(outcome.reason, "reads '~/.ssh/id_rsa' outside the project");

  assert.equal(read('../outside.txt').decision, 'ask');
  assert.equal(read(path.join(outside, 'secret.txt')).decision, 'ask');
});

test('a read approval has a key of its own', () => {
  assert.notEqual(
    approvalKey({kind: 'read', path: 'src/a.ts'}),
    approvalKey({kind: 'write', path: 'src/a.ts'}),
  );
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

test('a rule never decides a write or a read', () => {
  assert.equal(write('src/a.ts', {deny: ['src/*']}).decision, 'allow');
  assert.equal(write('../outside.txt', {allow: ['*']}).decision, 'ask');
  assert.equal(write('../outside.txt', {allow: ['*']}).suppressible, false);
  assert.equal(read('src/a.ts', {deny: ['src/*']}).decision, 'allow');
  assert.equal(read('../outside.txt', {allow: ['*']}).decision, 'ask');
  assert.equal(read('../outside.txt', {allow: ['*']}).suppressible, false);
});

test('clearing the conversation keeps the rules', () => {
  const session = createSession(project, 'system', 100);
  session.rules = rules({allow: ['npm run *']});
  session.allowed.add('bash ls');

  clearSession(session);

  assert.deepEqual(session.rules, rules({allow: ['npm run *']}));
  assert.equal(session.allowed.size, 0);
});

test('auto-edits decides exactly what the classifier alone decided', () => {
  for (const text of [...QUIET, ...ADVERSARIAL]) {
    assert.deepEqual(command(text, undefined, 'auto-edits'), command(text), text);
  }
  assert.deepEqual(write('src/a.ts', undefined, 'auto-edits'), write('src/a.ts'));
  assert.deepEqual(read('src/a.ts', undefined, 'auto-edits'), read('src/a.ts'));
});

test('ask-edits asks about a write that auto-edits runs', () => {
  const asking = write('src/a.ts', undefined, 'ask-edits');
  assert.equal(asking.decision, 'ask');
  assert.equal(asking.suppressible, true);
  assert.equal(write('src/a.ts', undefined, 'auto-edits').decision, 'allow');

  assert.equal(command('echo x > src/a.ts', undefined, 'ask-edits').decision, 'ask');
  assert.equal(command('npm test', undefined, 'ask-edits').decision, 'ask');
});

test('ask-edits runs a read without a prompt', () => {
  for (const text of ['ls -la', 'git status', 'rg TODO']) {
    assert.equal(command(text, undefined, 'ask-edits').decision, 'allow', text);
  }
  assert.equal(read('src/a.ts', undefined, 'ask-edits').decision, 'allow');
});

test('an escape is never remembered in any mode', () => {
  for (const text of ['sudo ls', 'git push', 'dd of=/dev/disk0', 'cat ~/.ssh/id_rsa']) {
    assert.equal(command(text, undefined, 'auto-edits').decision, 'ask', text);
    assert.equal(command(text, undefined, 'ask-edits').decision, 'ask', text);
    for (const mode of ['auto-edits', 'ask-edits'] as Mode[]) {
      assert.equal(command(text, undefined, mode).suppressible, false, `${mode} ${text}`);
    }
  }
});

test('a deny rule still refuses in every mode', () => {
  for (const mode of ['auto-edits', 'ask-edits'] as Mode[]) {
    const refused = command('ls', {deny: ['ls*']}, mode);
    assert.equal(refused.decision, 'deny', mode);
    assert.equal(refused.suppressible, false, mode);
    assert.match(refused.reason, /settings\.json/, mode);
  }
});

test('no mode returns deny on its own', () => {
  for (const mode of MODES) {
    assert.equal(write('.git/config', undefined, mode).decision, 'ask', mode);
    assert.equal(command('rm build.log', undefined, mode).decision, 'ask', mode);
    assert.equal(command('python3 build.py', undefined, mode).decision, 'ask', mode);

    for (const text of ['sudo ls', 'git push', 'dd of=/dev/disk0']) {
      const escape = command(text, undefined, mode);
      assert.equal(escape.decision, 'ask', `${mode} ${text}`);
      assert.equal(escape.suppressible, false, `${mode} ${text}`);
    }
  }
});

test('a new session starts in auto-edits', () => {
  assert.equal(createSession(project, 'system', 100).mode, 'auto-edits');
});

const alwaysApproves: Host = {
  signal: new AbortController().signal,
  onEvent() {},
  async confirm() {
    return 'session';
  },
};

function ctxOf(session: Session, host: Host = alwaysApproves): ToolContext {
  return {
    root: session.root,
    host,
    allowed: session.allowed,
    rules: session.rules,
    mode: session.mode,
  };
}

const fakeBash: Tool = {
  name: 'bash',
  description: 'fake',
  schema: z.object({command: z.string()}),
  request(args) {
    return {kind: 'command', command: (args as {command: string}).command};
  },
  async run() {
    return {text: '[exit 0]'};
  },
};

function write_file(session: Session, host?: Host): Promise<{text: string}> {
  return runTool(
    tools,
    'write_file',
    JSON.stringify({path: 'src/a.ts', content: 'one\n'}),
    ctxOf(session, host),
  );
}

test('the gate follows a switch inside one session', async () => {
  const session = createSession(project, 'system', 100);
  const watching = counting();

  const before = await write_file(session, watching.host);
  assert.doesNotMatch(before.text, /^Error/, before.text);
  assert.equal(watching.count(), 0);

  setMode(session, 'ask-edits');

  const after = await write_file(session, watching.host);
  assert.doesNotMatch(after.text, /^Error/, after.text);
  assert.equal(watching.count(), 1);
});

test('an approval granted in auto-edits still holds in ask-edits', async () => {
  const session = createSession(project, 'system', 100);
  const registry = [fakeBash];
  const args = JSON.stringify({command: 'rm build.log'});
  let confirms = 0;
  const remembering: Host = {
    signal: new AbortController().signal,
    onEvent() {},
    async confirm() {
      confirms += 1;
      return 'session';
    },
  };

  const approved = await runTool(registry, 'bash', args, ctxOf(session, remembering));
  assert.equal(approved.text, '[exit 0]');
  assert.equal(session.allowed.size, 1);
  assert.equal(confirms, 1);

  setMode(session, 'ask-edits');

  const again = await runTool(registry, 'bash', args, ctxOf(session, remembering));
  assert.equal(again.text, '[exit 0]');
  assert.equal(session.allowed.size, 1);
  assert.equal(confirms, 1);
});

test('a deny rule refuses a write the mode would have allowed', () => {
  const refused = write('src/a.ts', {deny: ['edit(**)']});

  assert.equal(refused.decision, 'deny');
  assert.equal(refused.suppressible, false);
  assert.match(refused.reason, /settings\.json/);
});

test('deny every edit but one directory is the whole feature', () => {
  const config = {deny: ['edit(**)'], allow: ['edit(plans/**)']};

  assert.equal(write('src/a.ts', config).decision, 'deny');
  assert.equal(write('plans/05.md', config).decision, 'allow');
  assert.match(write('plans/05.md', config).reason, /settings\.json/);
});

test('an allow rule lets a write through a mode that would ask', () => {
  const asked = write('src/a.ts', undefined, 'ask-edits');
  assert.equal(asked.decision, 'ask');

  const allowed = write('src/a.ts', {allow: ['edit(src/**)']}, 'ask-edits');
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.reason, /settings\.json/);
});

test('an ask rule stops a write the mode would have run silently', () => {
  assert.equal(write('src/a.ts', undefined, 'auto-edits').decision, 'allow');

  const asked = write('src/a.ts', {ask: ['edit(**)']}, 'auto-edits');
  assert.equal(asked.decision, 'ask');
  assert.equal(asked.suppressible, true);
  assert.match(asked.reason, /settings\.json/);
});

test('no allow rule can rescue a write that leaves the project', () => {
  const target = path.join(outside, 'a.ts');
  for (const config of [{allow: ['edit(**)']}, {allow: ['edit(*)']}]) {
    const refused = write(target, config);
    assert.equal(refused.decision, 'ask', target);
    assert.equal(refused.suppressible, false, target);
    assert.doesNotMatch(refused.reason, /settings\.json/, target);
  }
});

test('a deny rule naming an outside path absolutely refuses a write', () => {
  const target = path.join(outside, 'a.ts');
  const refused = write(target, {deny: [`edit(${outside}/**)`]});
  assert.equal(refused.decision, 'deny');
  assert.equal(refused.suppressible, false);
  assert.match(refused.reason, /settings\.json/);
});

test('no relative deny rule reaches a write that leaves the project', () => {
  const target = path.join(outside, 'a.ts');
  for (const config of [{deny: ['edit(**)']}, {deny: ['edit(*)']}]) {
    const asking = write(target, config);
    assert.equal(asking.decision, 'ask', target);
    assert.equal(asking.suppressible, false, target);
    assert.doesNotMatch(asking.reason, /settings\.json/, target);
  }
});

test('an absolute allow rule still cannot rescue a write that leaves the project', () => {
  const target = path.join(outside, 'a.ts');
  const refused = write(target, {allow: [`edit(${outside}/**)`]});
  assert.equal(refused.decision, 'ask');
  assert.equal(refused.suppressible, false);
  assert.doesNotMatch(refused.reason, /settings\.json/);
});

test('an allow rule does reach a protected path', () => {
  assert.equal(write('.git/config').decision, 'ask');

  const allowed = write('.git/config', {allow: ['edit(**)']});
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.reason, /settings\.json/);
});

test('an edit rule never governs a read', () => {
  assert.equal(read('src/a.ts', {deny: ['edit(**)']}).decision, 'allow');
  assert.equal(read('.git/config', {deny: ['edit(**)']}).decision, 'allow');
});

test('an edit rule leaves a bash redirect to the bash rules', () => {
  const text = 'echo x > src/a.ts';
  assert.deepEqual(command(text, {deny: ['edit(**)']}), command(text));
  assert.deepEqual(command(text, {allow: ['edit(**)']}), command(text));
});

function counting(): {host: Host; count: () => number} {
  let confirms = 0;
  return {
    host: {
      signal: new AbortController().signal,
      onEvent() {},
      async confirm() {
        confirms += 1;
        return 'once';
      },
    },
    count: () => confirms,
  };
}

function writeWith(host: Host, some: RuleText, mode: Mode): Promise<{text: string}> {
  const session = createSession(project, 'system', 100);
  return runTool(tools, 'write_file', JSON.stringify({path: 'src/a.ts', content: 'one\n'}), {
    root: session.root,
    host,
    allowed: session.allowed,
    rules: rules(some),
    mode,
  });
}

test('an allow rule runs a write with no prompt at all', async () => {
  const asking = counting();
  const asked = await writeWith(asking.host, {}, 'ask-edits');
  assert.doesNotMatch(asked.text, /^Error/, asked.text);
  assert.equal(asking.count(), 1);

  const allowing = counting();
  const allowed = await writeWith(allowing.host, {allow: ['edit(src/**)']}, 'ask-edits');
  assert.doesNotMatch(allowed.text, /^Error/, allowed.text);
  assert.equal(allowing.count(), 0);
});

test('a deny rule refuses a write through runTool without a prompt', async () => {
  const denying = counting();
  fs.rmSync(path.join(project, 'src/a.ts'), {force: true});
  const refused = await writeWith(denying.host, {deny: ['edit(**)']}, 'auto-edits');

  assert.match(refused.text, /^Error/);
  assert.match(refused.text, /settings\.json/);
  assert.equal(denying.count(), 0);
  assert.equal(fs.existsSync(path.join(project, 'src/a.ts')), false);
});
