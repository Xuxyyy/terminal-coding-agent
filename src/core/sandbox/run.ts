import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
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
  outputIncomplete?: boolean;
  cleanupUncertain?: boolean;
};

export const OUTPUT_LIMIT = 32 * 1024 * 1024;
const STOP_TIMEOUT_MS = 1000;
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
  const publicCertificates = ['(subpath "/etc/ssl/certs")', '(subpath "/etc/pki/tls/certs")', '(literal "/private/etc/ssl/cert.pem")'];
  rules.push(`(deny file-read* file-write* (require-all (regex ${quote(PRIVATE_PATTERN)}) (require-not ${subpath(policy.temporary)}) ${publicCertificates.map((filter) => `(require-not ${filter})`).join(' ')}))`);
  const examples = ['.env.example', '.env.sample', '.env.template'].map((name) => `(regex ${quote(`/${name.replaceAll('.', '\\.')}$`)})`);
  rules.push(`(deny file-read* file-write* (require-all (regex ${quote(ENV_PATTERN)}) (require-not ${subpath(policy.temporary)}) ${examples.map((filter) => `(require-not ${filter})`).join(' ')}))`);
  if (policy.blocked.length) rules.push(`(deny file-read* file-write* ${policy.blocked.map(subpath).join(' ')})`);
  if (policy.protectedWrites.length) rules.push(`(deny file-write* ${policy.protectedWrites.map(subpath).join(' ')})`);
  const frozen = new Set([policy.root, ...policy.blocked.flatMap((target) => ancestorsWithin(target, policy.writes)), ...policy.protectedWrites.flatMap((target) => ancestorsWithin(target, policy.writes))]);
  rules.push(`(deny file-write-unlink ${[...frozen].map((target) => `(literal ${quote(target)})`).join(' ')})`);
  return rules.join('\n');
}

function launch(policy: SandboxPolicy, program: string, args: string[]): {program: string; args: string[]} {
  if (!fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('sandbox unavailable: macOS sandbox-exec is required; the command was not run');
  return {program: '/usr/bin/sandbox-exec', args: ['-p', macProfile(policy), program, ...args]};
}

export type RunOptions = {
  root: string;
  program: string;
  args: string[];
  signal: AbortSignal;
  access?: SandboxAccess;
  input?: string;
  timeoutMs?: number | null;
  captureOutput?: boolean;
  outputFd?: number;
  onExit?: (code: number | null) => void;
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
};

export type RunningCommand = {
  pid: number | undefined;
  ready: Promise<void>;
  result: Promise<SandboxResult>;
  temporary: string;
  detach: () => void;
  stop: (reason?: 'interrupted' | 'timeout') => void;
};

export function runSandboxed(options: RunOptions): Promise<SandboxResult> {
  return runCommand({...options, sandbox: 'on'});
}

export async function runCommand(options: RunOptions & {sandbox?: SandboxMode}): Promise<SandboxResult> {
  if (options.signal.aborted) return {code: 130, stdout: '', stderr: '', interrupted: true, timedOut: false};
  return startCommand(options).result;
}

export function startCommand(options: RunOptions & {sandbox?: SandboxMode}): RunningCommand {
  if (options.signal.aborted) throw new DOMException('The command was interrupted before startup', 'AbortError');
  const isolated = (options.sandbox ?? DEFAULT_SANDBOX) === 'on';
  if (isolated && process.platform !== 'darwin') {
    throw new Error(`sandbox unavailable on ${process.platform}: Sandbox On is supported only on macOS; the command was not run`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sandbox-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const policy = isolated ? makePolicy(options.root, temporary, options.access) : null;
    const wrapper = [
      '--noprofile', '--norc', '-c', `printf '%s' '${READY_MARKER}' >&${options.outputFd === undefined ? 2 : 3}; ${options.outputFd === undefined ? '' : 'exec 3>&-; '}exec "$@"`,
      'acc-sandbox', options.program, ...options.args,
    ];
    const command = policy
      ? launch(policy, '/bin/bash', wrapper)
      : {program: options.program, args: options.args};
    const child = spawn(command.program, command.args, {
      cwd: policy?.root ?? options.root,
      env: cleanEnvironment(temporary),
      detached: true,
      stdio: options.outputFd === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', options.outputFd, options.outputFd, ...(isolated ? ['pipe' as const] : [])],
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveResult!: (value: SandboxResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<SandboxResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void ready.catch(() => {});
    void result.catch(() => {});
    let stdout = '';
    let stderr = '';
    let startupError = '';
    let size = 0;
    let timedOut = false;
    let interrupted = false;
    let initialized = false;
    let settled = false;
    let detached = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let outputIncomplete = false;
    let stopTimer: NodeJS.Timeout | undefined;
    let failure: Error | undefined;
    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')};
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const terminate = () => {
      if (settled || detached) return;
      if (drainTimer) clearTimeout(drainTimer);
      kill();
      stopTimer ??= setTimeout(() => {
        failure = new Error(`${failure ? `${failure.message}; ` : ''}command cleanup did not finish within ${STOP_TIMEOUT_MS}ms after stopping; output may be incomplete and some processes may still be running`);
        child.stdin!.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(child.exitCode, child.signalCode);
      }, STOP_TIMEOUT_MS);
    };
    const stop = (reason: 'interrupted' | 'timeout' = 'interrupted') => {
      if (settled || detached) return;
      if (reason === 'timeout') timedOut = true;
      else interrupted = true;
      terminate();
    };
    const timer = options.timeoutMs === null ? null : setTimeout(() => stop('timeout'), options.timeoutMs ?? 120_000);
    const abort = () => stop();
    options.signal.addEventListener('abort', abort, {once: true});
    if (options.signal.aborted) abort();
    const emit = (text: string, stream: 'stdout' | 'stderr') => {
      if (!text) return;
      if (options.captureOutput !== false) {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      }
      options.onOutput?.(text, stream);
    };
    const decode = (text: string, stream: 'stdout' | 'stderr') => {
      if (isolated && stream === 'stderr' && !initialized) {
        startupError += text;
        const marker = startupError.indexOf(READY_MARKER);
        if (marker < 0) return;
        text = startupError.slice(0, marker) + startupError.slice(marker + READY_MARKER.length);
        startupError = '';
        initialized = true;
        resolveReady();
      }
      emit(text, stream);
    };
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (failure || settled) return;
      const available = OUTPUT_LIMIT - size;
      size += chunk.length;
      try {
        decode(decoders[stream].write(chunk.subarray(0, Math.max(0, available))), stream);
      } catch (error) {
        failure = error as Error;
      }
      if (size > OUTPUT_LIMIT) failure = new Error('command exceeded the 32 MiB output limit');
      if (failure) terminate();
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    if (isolated && options.outputFd !== undefined) {
      child.stdio[3]?.on('data', (chunk: Buffer) => {
        startupError += chunk.toString('utf8');
        if (startupError.includes(READY_MARKER)) { initialized = true; resolveReady(); }
      });
    }
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input);
    child.on('spawn', () => {
      if (settled) return;
      if (!isolated) { initialized = true; resolveReady(); }
    });
    child.on('error', (error) => {
      if (settled) return;
      failure = new Error(`${isolated ? 'sandbox' : 'command'} could not start: ${error.message}; the command was not run`);
      rejectReady(failure);
      terminate();
    });
    child.on('exit', (code, signal) => {
      if (settled || detached) return;
      options.onExit?.(code);
      kill();
      if (!stopTimer) drainTimer = setTimeout(() => {
        outputIncomplete = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(code, signal);
      }, STOP_TIMEOUT_MS);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || detached) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal.removeEventListener('abort', abort);
      kill();
      try {
        if (!failure) {
          decode(decoders.stdout.end(), 'stdout');
          decode(decoders.stderr.end(), 'stderr');
        }
        fs.rmSync(temporary, {recursive: true, force: true});
      } catch (error) {
        failure ??= error as Error;
      }
      if (!failure && !interrupted && !timedOut && !initialized) {
        failure = new Error(`sandbox could not initialize; the command was not run. ${startupError.trim() || `Backend exited with ${signal ?? code} before command startup.`} Path or network grants cannot fix backend setup.`);
      }
      if (!initialized) rejectReady(failure ?? new Error('command stopped before startup'));
      if (failure) rejectResult(failure);
      else resolveResult({code: interrupted ? 130 : timedOut ? 124 : code ?? 1, stdout, stderr, interrupted, timedOut, ...(outputIncomplete ? {outputIncomplete: true, cleanupUncertain: true} : {})});
    };
    child.on('close', finish);
    const detach = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) throw new Error('service exited before handoff');
      if (options.outputFd === undefined) throw new Error('service handoff requires independent log output');
      detached = true;
      child.stdin?.destroy();
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      child.unref();
    };
    return {pid: child.pid, ready, result, stop, detach, temporary};
  } catch (error) {
    fs.rmSync(temporary, {recursive: true, force: true});
    throw error;
  }
}
