import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {insideRoot} from '../permission/protected.js';
import {DEFAULT_SANDBOX, type SandboxMode} from './mode.js';
import {cleanEnvironment, ENV_PATTERN, makePolicy, PRIVATE_PATTERN, type SandboxAccess, type SandboxPolicy} from './policy.js';

export type SandboxResult = {
  code: number;
  stdout: string;
  stderr: string;
  interrupted: boolean;
  timedOut: boolean;
};

const OUTPUT_LIMIT = 32 * 1024 * 1024;
const READY_MARKER = '\u001eacc-sandbox-ready\u001f';
const quote = (value: string) => JSON.stringify(value);
const subpath = (value: string) => `(subpath ${quote(value)})`;

function ancestorsWithin(target: string, roots: string[]): string[] {
  const result: string[] = [];
  let current = path.dirname(target);
  while (roots.some((root) => insideRoot(current, root))) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export function macProfile(policy: SandboxPolicy): string {
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow process-info* signal mach-priv-task-port (target same-sandbox))',
    '(allow file-read-metadata)',
    // dyld reads the root directory itself during startup; this does not grant its children.
    '(allow file-read* (literal "/"))',
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "kern.os") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.hostname") (sysctl-name "kern.version") (sysctl-name "kern.tcsm_enable"))',
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    '(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(allow file-read* ${policy.reads.map(subpath).join(' ')})`,
    `(allow file-write* ${policy.writes.map(subpath).join(' ')})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))',
    '(allow file-write* file-ioctl (literal "/dev/null") (subpath "/dev/fd"))',
    `(allow system-socket (socket-domain AF_UNIX))`,
    `(allow network-bind (local unix-socket ${subpath(policy.temporary)}))`,
    `(allow network-outbound (remote unix-socket ${subpath(policy.temporary)}))`,
  ];
  if (policy.network) {
    rules.push(
      '(allow network-outbound (remote ip "*:*"))',
      '(allow network-bind network-inbound (local ip "*:*"))',
      '(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))',
      '(allow mach-lookup (global-name "com.apple.mDNSResponder"))',
      '(allow file-read* (literal "/private/etc/resolv.conf") (literal "/private/etc/hosts"))',
    );
  }
  // Denies follow all allows. Private scratch files are created by the command itself,
  // so tests can use fake .env files there without exposing host credential files.
  const publicCertificates = ['(subpath "/etc/ssl/certs")', '(subpath "/etc/pki/tls/certs")', '(literal "/private/etc/ssl/cert.pem")'];
  rules.push(`(deny file-read* file-write* (require-all (regex ${quote(PRIVATE_PATTERN)}) (require-not ${subpath(policy.temporary)}) ${publicCertificates.map((filter) => `(require-not ${filter})`).join(' ')}))`);
  const examples = ['.env.example', '.env.sample', '.env.template'].map((name) => `(regex ${quote(`/${name.replaceAll('.', '\\.')}$`)})`);
  rules.push(`(deny file-read* file-write* (require-all (regex ${quote(ENV_PATTERN)}) (require-not ${subpath(policy.temporary)}) ${examples.map((filter) => `(require-not ${filter})`).join(' ')}))`);
  if (policy.blocked.length) rules.push(`(deny file-read* file-write* ${policy.blocked.map(subpath).join(' ')})`);
  if (policy.protectedWrites.length) rules.push(`(deny file-write* ${policy.protectedWrites.map(subpath).join(' ')})`);
  // Renaming a credential's enclosing directory must not remove its path protection.
  const frozen = new Set([policy.root, ...policy.blocked.flatMap((target) => ancestorsWithin(target, policy.writes)), ...policy.protectedWrites.flatMap((target) => ancestorsWithin(target, policy.writes))]);
  rules.push(`(deny file-write-unlink ${[...frozen].map((target) => `(literal ${quote(target)})`).join(' ')})`);
  return rules.join('\n');
}

function launch(policy: SandboxPolicy, program: string, args: string[]): {program: string; args: string[]} {
  if (!fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('sandbox unavailable: macOS sandbox-exec is required; the command was not run');
  return {program: '/usr/bin/sandbox-exec', args: ['-p', macProfile(policy), program, ...args]};
}

type RunOptions = {
  root: string;
  program: string;
  args: string[];
  signal: AbortSignal;
  access?: SandboxAccess;
  input?: string;
  timeoutMs?: number;
};

// Explicit isolation entry point for enforcement tests and callers requiring On.
export function runSandboxed(options: RunOptions): Promise<SandboxResult> {
  return runCommand({...options, sandbox: 'on'});
}

export async function runCommand(options: RunOptions & {sandbox?: SandboxMode}): Promise<SandboxResult> {
  if (options.signal.aborted) return {code: 130, stdout: '', stderr: '', interrupted: true, timedOut: false};
  const isolated = (options.sandbox ?? DEFAULT_SANDBOX) === 'on';
  if (isolated && process.platform !== 'darwin') {
    throw new Error(`sandbox unavailable on ${process.platform}: Sandbox On is supported only on macOS; the command was not run`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sandbox-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const policy = isolated ? makePolicy(options.root, temporary, options.access) : null;
    // The trusted wrapper signals that OS setup succeeded before executing user code.
    // This distinguishes backend errors from a command that failed after changing files.
    const wrapper = [
      '--noprofile', '--norc', '-c', `printf '%s' '${READY_MARKER}' >&2; exec "$@"`,
      'acc-sandbox', options.program, ...options.args,
    ];
    const command = policy
      ? launch(policy, '/bin/bash', wrapper)
      : {program: options.program, args: options.args};
    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(command.program, command.args, {
        cwd: policy?.root ?? options.root,
        env: cleanEnvironment(temporary),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let size = 0;
      let timedOut = false;
      let overflow = false;
      let ready = !isolated;
      const kill = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 120_000);
      const abort = () => kill();
      options.signal.addEventListener('abort', abort, {once: true});
      if (options.signal.aborted) kill();
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) { overflow = true; kill(); return; }
        if (stream === 'stdout') stdout += chunk.toString('utf8');
        else {
          stderr += chunk.toString('utf8');
          if (isolated && stderr.includes(READY_MARKER)) {
            ready = true;
            stderr = stderr.replace(READY_MARKER, '');
          }
        }
      };
      child.stdout!.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
      child.stderr!.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
      child.stdin!.on('error', () => {}); // A denied launch can close stdin before the worker reads it.
      child.stdin!.end(options.input);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        kill();
      };
      child.on('error', (error) => { cleanup(); reject(new Error(`${isolated ? 'sandbox' : 'command'} could not start: ${error.message}; the command was not run`)); });
      // Reap ordinary background children too, rather than leaving approved access alive.
      child.on('exit', () => kill());
      child.on('close', (code, signal) => {
        cleanup();
        if (overflow) { reject(new Error('command exceeded the 32 MiB output limit')); return; }
        const interrupted = options.signal.aborted;
        if (!interrupted && !timedOut && !ready) {
          reject(new Error(`sandbox could not initialize; the command was not run. ${stderr.trim() || `Backend exited with ${signal ?? code} before command startup.`} Path or network grants cannot fix backend setup.`));
          return;
        }
        resolve({code: interrupted ? 130 : timedOut ? 124 : code ?? 1, stdout, stderr, interrupted, timedOut});
      });
    });
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}
