import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {once} from 'node:events';
import test, {type TestContext} from 'node:test';
import {cleanEnvironment, makePolicy, normalizeAccess, type SandboxAccess} from '../../core/sandbox/policy.js';
import {linuxArguments, macProfile, runCommand, runSandboxed} from '../../core/sandbox/run.js';
import {bash} from '../../core/tools/bash.js';
import {readFile} from '../../core/tools/read.js';
import {writeFile} from '../../core/tools/write.js';
import {editFile} from '../../core/tools/edit.js';
import {grep} from '../../core/tools/grep.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';
import type {ConfirmRequest, ConfirmDecision} from '../../core/host.js';
import {captureSnapshot} from '../../core/history.js';
import {fileOperation} from '../../core/sandbox/files.js';

const native = process.platform === 'darwin' || (process.platform === 'linux' && ['/usr/bin/bwrap', '/bin/bwrap'].some((target) => fs.existsSync(target)));
const live = {skip: native ? false : 'OS sandbox backend is not installed; fail-closed behavior is tested separately'};
const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const nodeCommand = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

function fixture(t: TestContext): {root: string; outside: string; temporary: string} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-boundary-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'project');
  const outside = path.join(directory, 'outside');
  const temporary = path.join(directory, 'scratch');
  for (const dir of [root, outside, temporary]) fs.mkdirSync(dir);
  return {root, outside, temporary};
}

function context(root: string, answer: ConfirmDecision = 'once') {
  const asked: ConfirmRequest[] = [];
  const ctx: ToolContext = {
    root,
    mode: 'auto-edits',
    sandbox: 'on',
    rules: {allow: [], ask: [], deny: []},
    allowed: new Set(),
    denied: [],
    host: {signal: new AbortController().signal, onEvent() {}, async confirm(request) { asked.push(request); return answer; }},
  };
  return {ctx, asked};
}

async function shell(ctx: ToolContext, command: string, access?: SandboxAccess) {
  return runTool([bash], 'bash', JSON.stringify({command, access}), ctx);
}

test('the child environment contains settings, not credentials or startup injection', () => {
  const env = cleanEnvironment('/private/scratch', {
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC', GEMINI_API_KEY: 'fake-key',
    ACC_MODEL_RELAY_URL: 'http://localhost/fake-capability', SSH_AUTH_SOCK: '/fake/socket',
    BASH_ENV: '/fake/startup', NODE_OPTIONS: '--require=/fake/injection', AWS_SECRET_ACCESS_KEY: 'fake',
  });
  for (const key of ['GEMINI_API_KEY', 'ACC_MODEL_RELAY_URL', 'SSH_AUTH_SOCK', 'BASH_ENV', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, '/private/scratch');
  assert.equal(env.TMPDIR, '/private/scratch');
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('resource grants reject credential paths, including a symlink alias', (t) => {
  const {root} = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'FAKE_PROVIDER_KEY=fake\n');
  fs.symlinkSync('.env', path.join(root, 'alias'));
  for (const target of ['.env', 'alias', '~/.ssh', '~/.acc']) assert.throws(() => normalizeAccess(root, {read_paths: [target]}), /credential storage/);
  assert.throws(() => normalizeAccess(root, {write_paths: ['/']}), /specific file or directory/);
});

test('policy protects hard-link aliases and enclosing directory renames', (t) => {
  const {root, temporary} = fixture(t);
  fs.mkdirSync(path.join(root, 'private'));
  const credential = path.join(root, 'private', '.env');
  fs.writeFileSync(credential, 'FAKE_PROVIDER_KEY=fake\n');
  fs.linkSync(credential, path.join(root, 'alias'));
  const policy = makePolicy(root, temporary);
  assert.ok(policy.blocked.includes(path.join(policy.root, 'alias')));
  const profile = macProfile(policy);
  assert.ok(profile.includes(`(literal ${JSON.stringify(path.join(policy.root, 'private'))})`));
  const linux = linuxArguments(policy, '/bin/true', []);
  assert.ok(linux.includes('--unshare-pid'));
  assert.ok(linux.includes('--unshare-net'));
  assert.ok(!linux.some((part, index) => part === '--ro-bind' && linux[index + 1] === '/'));
  assert.ok(linux.includes(path.join(policy.root, 'alias')));
});

test('ordinary Shell builds and edits still work without granting network', live, async (t) => {
  const {root} = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'node -e "require(\'node:fs\').writeFileSync(\'generated.txt\', \'built\')"'}}));
  const {ctx, asked} = context(root);
  const output = await shell(ctx, 'npm test');
  assert.match(output.text, /^\[exit 0\]/);
  assert.equal(fs.readFileSync(path.join(root, 'generated.txt'), 'utf8'), 'built');
  assert.equal(asked.length, 0);
});

test('Shell and its children cannot recover the parent key, relay URL, or startup environment', live, async (t) => {
  const {root} = fixture(t);
  const injected = {GEMINI_API_KEY: 'FAKE_PARENT_PROVIDER_KEY', ACC_MODEL_RELAY_URL: 'http://localhost/FAKE_RELAY_CAPABILITY', BASH_ENV: path.join(root, 'startup.sh')};
  fs.writeFileSync(injected.BASH_ENV, 'printf FAKE_STARTUP_INJECTION');
  for (const [key, value] of Object.entries(injected)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const {ctx} = context(root);
  const output = await shell(ctx, nodeCommand(`require('node:child_process').execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'env'], {stdio: 'inherit'});`));
  assert.match(output.text, /^\[exit 0\]/);
  assert.doesNotMatch(output.text, /FAKE_PARENT_PROVIDER_KEY|FAKE_RELAY_CAPABILITY|FAKE_STARTUP_INJECTION/);
  assert.equal(process.env.GEMINI_API_KEY, injected.GEMINI_API_KEY); // The trusted model runtime retains its key.
});

test('all file tools refuse project credentials before prompting or backing up', live, async (t) => {
  const {root} = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'FAKE_SECRET_MUST_NOT_APPEAR');
  fs.mkdirSync(path.join(root, '.acc'));
  fs.writeFileSync(path.join(root, '.acc', 'session.json'), 'FAKE_PRIVATE_SESSION');
  const {ctx, asked} = context(root);
  let backups = 0;
  ctx.backup = () => { backups++; };
  const registry = [readFile, writeFile, editFile, grep];
  for (const [name, args] of [
    ['read_file', {path: '.env'}], ['write_file', {path: '.env', content: 'replacement'}],
    ['edit_file', {path: '.env', old_string: 'FAKE_SECRET_MUST_NOT_APPEAR', new_string: 'replacement'}],
    ['grep', {path: '.acc', pattern: 'FAKE'}],
  ] as const) {
    const output = await runTool(registry, name, JSON.stringify(args), ctx);
    assert.match(output.text, /sandbox blocks credential storage/);
    assert.doesNotMatch(output.text, /FAKE_SECRET_MUST_NOT_APPEAR|FAKE_PRIVATE_SESSION/);
  }
  assert.equal(asked.length, 0);
  assert.equal(backups, 0);
  const output = await runTool(registry, 'grep', JSON.stringify({pattern: 'FAKE', output_mode: 'content'}), ctx);
  assert.doesNotMatch(output.text, /FAKE_SECRET_MUST_NOT_APPEAR|FAKE_PRIVATE_SESSION/);
});

test('Shell cannot read, hard-link, or rename project credentials into view', live, async (t) => {
  const {root} = fixture(t);
  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'private', '.env'), 'FAKE_FILE_SECRET_MUST_STAY_HIDDEN');
  fs.linkSync(path.join(root, 'private', '.env'), path.join(root, 'alias'));
  const {ctx} = context(root);
  for (const command of [
    'cat private/.env', 'cat alias', 'ln private/.env linked && cat linked',
    'mv private renamed && cat renamed/.env', '/bin/bash --noprofile --norc -c "cat private/.env"',
  ]) {
    const output = await shell(ctx, command);
    assert.doesNotMatch(output.text, /FAKE_FILE_SECRET_MUST_STAY_HIDDEN/);
    assert.doesNotMatch(output.text, /^\[exit 0\]/);
  }
});

test('an outside read grant covers one file, expires, and cannot be granted by the judge', live, async (t) => {
  const {root, outside} = fixture(t);
  const allowed = path.join(outside, 'allowed.txt');
  const sibling = path.join(outside, 'sibling.txt');
  fs.writeFileSync(allowed, 'GRANTED_CONTENT');
  fs.writeFileSync(sibling, 'UNGRANTED_CONTENT');
  const {ctx, asked} = context(root, 'session');
  ctx.mode = 'auto';
  let judgments = 0;
  ctx.judge = async () => { judgments++; return 'allow'; };
  const command = `cat ${quote(allowed)}`;
  ctx.allowed.add(command);
  const output = await shell(ctx, command, {read_paths: [allowed]});
  assert.match(output.text, /GRANTED_CONTENT/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].suppressible, false);
  assert.equal(judgments, 0);
  const ungranted = await shell(ctx, command);
  assert.doesNotMatch(ungranted.text, /GRANTED_CONTENT/);
  const other = await shell(ctx, `cat ${quote(sibling)}`, {read_paths: [allowed]});
  assert.doesNotMatch(other.text, /UNGRANTED_CONTENT/);
});

test('a symlink changed after approval cannot widen an outside file grant', live, async (t) => {
  const {root, outside} = fixture(t);
  const allowed = path.join(outside, 'allowed.txt');
  const other = path.join(outside, 'other.txt');
  const link = path.join(root, 'link');
  fs.writeFileSync(allowed, 'GRANTED');
  fs.writeFileSync(other, 'UNGRANTED_SYMLINK_CONTENT');
  fs.symlinkSync(allowed, link);
  const {ctx} = context(root);
  ctx.host.confirm = async () => { fs.unlinkSync(link); fs.symlinkSync(other, link); return 'once'; };
  const output = await runTool([readFile], 'read_file', JSON.stringify({path: 'link'}), ctx);
  assert.doesNotMatch(output.text, /UNGRANTED_SYMLINK_CONTENT/);
  assert.match(output.text, /^Error:/);
});

test('write grants cannot change sibling files or credential storage', live, async (t) => {
  const {root, outside} = fixture(t);
  const allowed = path.join(outside, 'allowed.txt');
  const sibling = path.join(outside, 'sibling.txt');
  fs.writeFileSync(allowed, 'old');
  fs.writeFileSync(sibling, 'unchanged');
  const {ctx} = context(root);
  const output = await shell(ctx, `printf changed > ${quote(allowed)}; printf bad > ${quote(sibling)}`, {write_paths: [allowed]});
  assert.equal(fs.readFileSync(allowed, 'utf8'), 'changed');
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'unchanged');
  assert.doesNotMatch(output.text, /^\[exit 0\]/);
  const blocked = await shell(ctx, 'true', {read_paths: ['~/.acc']});
  assert.match(blocked.text, /credential storage/);
});

test('network is blocked until a one-command approval and does not uncover credentials', live, async (t) => {
  const {root} = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'FAKE_NETWORK_SECRET');
  let hits = 0;
  const server = http.createServer((_request, response) => { hits++; response.end('LOCAL_NETWORK_OK'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as net.AddressInfo;
  const command = `/usr/bin/curl --noproxy '*' --max-time 2 --silent --show-error http://127.0.0.1:${address.port}`;
  const {ctx, asked} = context(root);
  const denied = await shell(ctx, command);
  assert.doesNotMatch(denied.text, /LOCAL_NETWORK_OK/);
  assert.equal(hits, 0);
  const granted = await shell(ctx, command, {network: true});
  assert.match(granted.text, /LOCAL_NETWORK_OK/);
  assert.equal(hits, 1);
  assert.equal(asked.at(-1)?.suppressible, false);
  const hidden = await shell(ctx, 'cat .env', {network: true});
  assert.doesNotMatch(hidden.text, /FAKE_NETWORK_SECRET/);
  await shell(ctx, command);
  assert.equal(hits, 1);
});

test('a network grant cannot connect to a host Unix socket exposed in the workspace', live, async (t) => {
  const {root} = fixture(t);
  const socket = path.join(root, 'host.sock');
  let hits = 0;
  const server = net.createServer((connection) => { hits++; connection.end('HOST_SOCKET'); });
  server.listen(socket);
  await once(server, 'listening');
  t.after(() => server.close());
  const {ctx} = context(root);
  const output = await shell(ctx, nodeCommand(`const s=require('node:net').connect(${JSON.stringify(socket)}); s.on('data',d=>process.stdout.write(d)); s.on('error',()=>process.exit(3));`), {network: true});
  assert.doesNotMatch(output.text, /HOST_SOCKET/);
  assert.equal(hits, 0);
});

test('failed sandbox setup never falls back to running the command', async (t) => {
  const {root} = fixture(t);
  const marker = path.join(root, 'should-not-exist');
  // A private workspace is always rejected before launching, on every platform.
  const privateRoot = path.join(root, '.acc');
  fs.mkdirSync(privateRoot);
  await assert.rejects(runSandboxed({root: privateRoot, program: '/bin/bash', args: ['-c', `touch ${quote(marker)}`], signal: new AbortController().signal}), /sandbox requires a project/);
  assert.equal(fs.existsSync(marker), false);
  if (!native) {
    await assert.rejects(runSandboxed({root, program: '/bin/bash', args: ['-c', `touch ${quote(marker)}`], signal: new AbortController().signal}), /sandbox unavailable/);
    assert.equal(fs.existsSync(marker), false);
  }
});

test('command errors are not mistaken for sandbox initialization failures', live, async (t) => {
  const {root} = fixture(t);
  const result = await runSandboxed({root, program: '/bin/bash', args: ['-c', 'touch changed; echo "bwrap: command error" >&2; exit 7'], signal: new AbortController().signal});
  assert.equal(result.code, 7);
  assert.equal(result.stderr, 'bwrap: command error\n');
  assert.equal(fs.existsSync(path.join(root, 'changed')), true);
});

test('timeout and cancellation kill ordinary child processes and report the reason', live, async (t) => {
  const {root} = fixture(t);
  const result = await runSandboxed({root, program: '/bin/bash', args: ['--noprofile', '--norc', '-c', 'sleep 20 & echo $! > child.pid; wait'], signal: new AbortController().signal, timeoutMs: 200});
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  const pid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const cancelled = await runSandboxed({root, program: '/bin/bash', args: ['-c', 'sleep 20'], signal: controller.signal});
  assert.equal(cancelled.interrupted, true);
  assert.equal(cancelled.code, 130);
});

test('backups preserve bytes obtained from the sandbox, including binary bytes', live, async (t) => {
  const {root, outside} = fixture(t);
  const bytes = Buffer.from([0, 255, 128, 65]);
  fs.writeFileSync(path.join(root, 'binary'), bytes);
  const {ctx} = context(root);
  let captured: Buffer | null = null;
  ctx.backup = (_target, snapshot) => { captured = snapshot; };
  await runTool([writeFile], 'write_file', JSON.stringify({path: 'binary', content: 'replacement'}), ctx);
  assert.deepEqual(captured, bytes);
  const hash = captureSnapshot(outside, captured);
  assert.ok(hash);
  assert.deepEqual(fs.readFileSync(path.join(outside, 'files', hash)), bytes);
});

for (const sandbox of ['off', 'on'] as const) {
  const available = sandbox === 'on' ? live : {};
  test(`${sandbox}: retained tools and backups work, and permission denials still win`, available, async (t) => {
    const {root} = fixture(t);
    const {ctx} = context(root);
    ctx.sandbox = sandbox;
    const snapshots: (Buffer | null)[] = [];
    ctx.backup = (_path, bytes) => snapshots.push(bytes);
    const tools = [writeFile, editFile, readFile, grep, bash];
    const call = (name: string, args: object) => runTool(tools, name, JSON.stringify(args), ctx);
    assert.match((await call('write_file', {path: 'note.txt', content: 'before\n'})).text, /^Wrote/);
    assert.match((await call('edit_file', {path: 'note.txt', old_string: 'before', new_string: 'after'})).text, /^Edited/);
    assert.match((await call('read_file', {path: 'note.txt'})).text, /after/);
    assert.match((await call('grep', {pattern: 'after'})).text, /note.txt/);
    assert.match((await call('bash', {command: 'cat note.txt'})).text, /\[exit 0\]\nafter/);
    assert.equal(snapshots[0], null);
    assert.equal(snapshots[1]!.toString(), 'before\n');
    const binary = Buffer.from([0, 255, 128, 10]);
    fs.writeFileSync(path.join(root, 'binary'), binary);
    const snapshot = await fileOperation({kind: 'snapshot', target: path.join(root, 'binary')}, ctx);
    assert.deepEqual(Buffer.from(snapshot.bytes!, 'base64'), binary);
    ctx.rules.deny.push({tag: 'bash', pattern: 'cat *'}, {tag: 'edit', pattern: 'note.txt'});
    assert.match((await call('bash', {command: 'cat note.txt'})).text, /denied by a rule/);
    assert.match((await call('write_file', {path: 'note.txt', content: 'denied'})).text, /denied by a rule/);
    assert.match((await call('read_file', {path: 'note.txt'})).text, /denied by a rule/);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'after\n');
  });

  test(`${sandbox}: actual child environment is clean and private scratch is removed`, available, async (t) => {
    const {root} = fixture(t);
    const names = ['GEMINI_API_KEY', 'ACC_MODEL_RELAY_URL', 'BASH_ENV', 'NODE_OPTIONS', 'SSH_AUTH_SOCK'];
    const prior = names.map((name) => process.env[name]);
    t.after(() => names.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name];
      else process.env[name] = prior[index];
    }));
    for (const name of names) process.env[name] = 'fake-only-do-not-inherit';
    const result = await runCommand({root, sandbox, program: process.execPath, args: ['-e',
      `console.log(JSON.stringify({home: process.env.HOME, tmp: process.env.TMPDIR, keys: ${JSON.stringify(names)}.filter(k => process.env[k])}))`],
      signal: new AbortController().signal});
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.keys, []);
    assert.equal(output.home, output.tmp);
    assert.equal(fs.existsSync(output.home), false);
  });

  test(`${sandbox}: timeout and cancellation stop ordinary child processes`, available, async (t) => {
    const {root} = fixture(t);
    const result = await runCommand({root, sandbox, program: '/bin/bash', args: ['--noprofile', '--norc', '-c',
      'sleep 20 & echo $! > mode-child.pid; wait'], signal: new AbortController().signal, timeoutMs: 250});
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124);
    const pid = Number(fs.readFileSync(path.join(root, 'mode-child.pid'), 'utf8'));
    if (process.platform === 'darwin' || sandbox === 'off') assert.throws(() => process.kill(pid, 0));
    const controller = new AbortController();
    const cancelled = runCommand({root, sandbox, program: '/bin/bash', args: ['-c', 'sleep 20'], signal: controller.signal});
    setTimeout(() => controller.abort(), 150);
    assert.equal((await cancelled).interrupted, true);
    assert.equal((await cancelled).code, 130);
  });
}

test('Off skips OS policy and backend setup, accepts ignored access, and exposes fake credential files', async (t) => {
  const {root} = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'fake-file-secret');
  const {ctx, asked} = context(root);
  ctx.sandbox = 'off';
  assert.match((await shell(ctx, 'cat .env', {read_paths: ['/'], network: true})).text, /fake-file-secret/);
  assert.ok(asked.every((request) => !request.reason.includes('Extra sandbox access')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...platform, value: 'unsupported-test-platform'});
  try {
    const options = {root, program: '/bin/bash', args: ['-c', 'echo ran'], signal: new AbortController().signal};
    assert.equal((await runCommand(options)).stdout, 'ran\n');
    await assert.rejects(runCommand({...options, sandbox: 'on'}), /sandbox unavailable/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('Off does not label ordinary filesystem or command failures as sandbox denials', async (t) => {
  const {root} = fixture(t);
  const {ctx} = context(root);
  ctx.sandbox = 'off';
  const result = await shell(ctx, "echo 'Permission denied' >&2; exit 7");
  assert.match(result.text, /^\[exit 7\]/);
  assert.doesNotMatch(result.text, /sandbox blocked/);
});
