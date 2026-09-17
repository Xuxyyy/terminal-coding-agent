import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const RESULTS_DIR = 'evals/results/operational';
export const SCRATCH_PREFIX = 'acc-operational-';
export const COMMAND_TIMEOUT = 120_000;
export const OUTPUT_LIMIT = 4_000;
export const SCENARIO_IDS = [
  'package-contents',
  'installed-binary',
  'print-flags-require-print',
  'interactive-requires-tty',
  'missing-provider-key',
  'unsafe-workspace-refused',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type ScenarioStatus = 'pass' | 'fail' | 'error';

export type CommandResult = {
  command: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type ScenarioResult = {
  kind: 'scenario';
  id: ScenarioId;
  status: ScenarioStatus;
  durationMs: number;
  detail: string;
  commands: CommandResult[];
};

export type OperationalMetadata = {
  startedAt: string;
  elapsedMs: number;
  git: {revision: string; dirty: boolean};
  node: string;
  platform: string;
  scenarioCount: number;
};

export type OperationalReport = {
  kind: 'report';
  total: number;
  passes: number;
  failures: number;
  errors: number;
  byScenario: Array<{id: ScenarioId; status: ScenarioStatus}>;
  metadata: OperationalMetadata;
};

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
};

type Evidence = {ok: boolean; detail: string; commands: CommandResult[]};

function truncate(text: string): string {
  return text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}… [truncated ${text.length - OUTPUT_LIMIT} chars]`;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): CommandResult {
  const started = Date.now();
  const run = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? COMMAND_TIMEOUT,
    killSignal: 'SIGTERM',
    encoding: 'utf8',
  });
  const error = run.error as NodeJS.ErrnoException | undefined;
  return {
    command: [executable, ...args].map(quote).join(' '),
    status: run.status,
    signal: run.signal,
    timedOut: error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - started,
    stdout: truncate(run.stdout ?? ''),
    stderr: truncate(run.stderr ?? ''),
    ...(error === undefined ? {} : {error: error.message}),
  };
}

export function isolatedEnv(
  accHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...source,
    ACC_HOME: accHome,
    DEEPSEEK_API_KEY: '',
    GLM_API_KEY: '',
    MOONSHOT_API_KEY: '',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: join(accHome, 'npm-cache'),
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

export function withScratch<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  try {
    return run(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

export function scenarioResult(
  id: ScenarioId,
  started: number,
  run: () => Evidence,
): ScenarioResult {
  try {
    const evidence = run();
    const commandError = evidence.commands.find(
      (command) => command.error !== undefined || command.timedOut,
    );
    return {
      kind: 'scenario',
      id,
      status: commandError === undefined ? (evidence.ok ? 'pass' : 'fail') : 'error',
      durationMs: Date.now() - started,
      detail:
        commandError === undefined
          ? evidence.detail
          : `${evidence.detail}; ${commandError.error ?? 'command timed out'}`,
      commands: evidence.commands,
    };
  } catch (error) {
    return {
      kind: 'scenario',
      id,
      status: 'error',
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
      commands: [],
    };
  }
}

export function gitState(cwd = process.cwd()): OperationalMetadata['git'] {
  const env = process.env;
  const revision = runCommand('git', ['rev-parse', 'HEAD'], {cwd, env});
  const status = runCommand(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    {cwd, env},
  );
  return {
    revision:
      revision.status === 0 && revision.stdout.trim().length > 0
        ? revision.stdout.trim()
        : 'unknown',
    dirty: status.status !== 0 || status.stdout.trim().length > 0,
  };
}

export function reportOf(
  results: ScenarioResult[],
  startedAt: Date,
  elapsedMs: number,
  cwd = process.cwd(),
): OperationalReport {
  return {
    kind: 'report',
    total: results.length,
    passes: results.filter((result) => result.status === 'pass').length,
    failures: results.filter((result) => result.status === 'fail').length,
    errors: results.filter((result) => result.status === 'error').length,
    byScenario: results.map(({id, status}) => ({id, status})),
    metadata: {
      startedAt: startedAt.toISOString(),
      elapsedMs,
      git: gitState(cwd),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      scenarioCount: results.length,
    },
  };
}

export function formatReport(report: OperationalReport): string {
  const rows = report.byScenario.map(
    ({id, status}) => `${id.padEnd(27)} ${status}`,
  );
  return [
    `${report.total} operational scenarios: ${report.passes} passed, ` +
      `${report.failures} failed, ${report.errors} errors`,
    '',
    ...rows,
  ].join('\n');
}

export function resultPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), RESULTS_DIR, `${stamp}.jsonl`);
}

export function writeResults(
  path: string,
  results: ScenarioResult[],
  report: OperationalReport,
): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    `${[...results, report].map((value) => JSON.stringify(value)).join('\n')}\n`,
  );
}

function commandSucceeded(command: CommandResult): boolean {
  return command.status === 0 && command.error === undefined && !command.timedOut;
}

function expectedFailure(
  command: CommandResult,
  pattern: RegExp,
): boolean {
  return (
    command.status !== null &&
    command.status !== 0 &&
    command.error === undefined &&
    !command.timedOut &&
    pattern.test(`${command.stdout}\n${command.stderr}`)
  );
}

function installedBinary(prefix: string): string {
  return join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'acc.cmd' : 'acc');
}

export function main(): number {
  const repository = process.cwd();
  const startedAt = new Date();
  const started = Date.now();

  return withScratch((scratch) => {
    const packDir = join(scratch, 'pack');
    const prefix = join(scratch, 'prefix');
    const workspace = join(scratch, 'workspace');
    const accHome = join(scratch, 'acc-home');
    for (const dir of [packDir, prefix, workspace, accHome]) {
      mkdirSync(dir, {recursive: true});
    }
    const env = isolatedEnv(accHome);
    const results: ScenarioResult[] = [];
    let archive: string | null = null;
    let binary: string | null = null;

    results.push(
      scenarioResult('package-contents', Date.now(), () => {
        const build = runCommand('npm', ['run', 'build'], {cwd: repository, env});
        if (!commandSucceeded(build)) {
          return {ok: false, detail: 'npm run build failed', commands: [build]};
        }
        const pack = runCommand(
          'npm',
          ['pack', '--silent', '--ignore-scripts', '--pack-destination', packDir],
          {cwd: repository, env},
        );
        if (!commandSucceeded(pack)) {
          return {ok: false, detail: 'npm pack failed', commands: [build, pack]};
        }
        const filename = pack.stdout.trim().split(/\r?\n/).at(-1);
        if (filename === undefined || filename.length === 0) {
          return {
            ok: false,
            detail: 'npm pack did not report an archive filename',
            commands: [build, pack],
          };
        }
        archive = join(packDir, filename);
        const required = [
          'package/package.json',
          'package/dist/cli.js',
          'package/dist/core/client.js',
        ];
        const listing = runCommand('tar', ['-tf', archive, ...required], {
          cwd: repository,
          env,
        });
        const manifest = runCommand(
          'tar',
          ['-xOf', archive, 'package/package.json'],
          {cwd: repository, env},
        );
        const commands = [build, pack, listing, manifest];
        if (!commandSucceeded(listing) || !commandSucceeded(manifest)) {
          return {ok: false, detail: 'packed archive could not be inspected', commands};
        }
        const packageJson = JSON.parse(manifest.stdout) as {
          bin?: Record<string, string>;
        };
        const ok = packageJson.bin?.['acc'] === 'dist/cli.js';
        return {
          ok,
          detail: ok
            ? 'archive contains the acc bin and required dist files'
            : `archive contract failed; bin=${packageJson.bin?.['acc'] ?? 'missing'}`,
          commands,
        };
      }),
    );

    results.push(
      scenarioResult('installed-binary', Date.now(), () => {
        if (archive === null || !existsSync(archive)) {
          throw new Error('package archive is unavailable');
        }
        const install = runCommand(
          'npm',
          [
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--prefix',
            prefix,
            archive,
          ],
          {cwd: repository, env},
        );
        binary = installedBinary(prefix);
        if (!commandSucceeded(install) || !existsSync(binary)) {
          return {
            ok: false,
            detail: `installed binary is missing at ${binary}`,
            commands: [install],
          };
        }
        const invoke = runCommand(binary, ['-p'], {cwd: workspace, env});
        return {
          ok: expectedFailure(invoke, /-p needs a value/),
          detail: 'installed binary was invoked through its generated bin link',
          commands: [install, invoke],
        };
      }),
    );

    results.push(
      scenarioResult('print-flags-require-print', Date.now(), () => {
        if (binary === null) throw new Error('installed binary is unavailable');
        const command = runCommand(binary, ['--json', '--yes'], {cwd: workspace, env});
        return {
          ok: expectedFailure(command, /--json and --yes only applies to print mode/),
          detail: 'print-only flags were rejected without -p',
          commands: [command],
        };
      }),
    );

    results.push(
      scenarioResult('interactive-requires-tty', Date.now(), () => {
        if (binary === null) throw new Error('installed binary is unavailable');
        const command = runCommand(binary, [], {cwd: workspace, env});
        return {
          ok: expectedFailure(command, /interactive mode requires a terminal/),
          detail: 'non-TTY interactive startup refused before model use',
          commands: [command],
        };
      }),
    );

    results.push(
      scenarioResult('missing-provider-key', Date.now(), () => {
        if (binary === null) throw new Error('installed binary is unavailable');
        const command = runCommand(
          binary,
          ['-p', 'Reply with hello.', '--max-seconds', '5'],
          {cwd: workspace, env, timeout: 15_000},
        );
        return {
          ok: expectedFailure(command, /DEEPSEEK_API_KEY is not set/),
          detail: 'print mode named the missing provider key without hanging',
          commands: [command],
        };
      }),
    );

    results.push(
      scenarioResult('unsafe-workspace-refused', Date.now(), () => {
        if (binary === null) throw new Error('installed binary is unavailable');
        const home = runCommand(binary, [], {cwd: homedir(), env});
        const filesystemRoot = resolve(repository, '/');
        const root = runCommand(binary, [], {cwd: filesystemRoot, env});
        const ok =
          expectedFailure(home, /refusing to run in your home directory/) &&
          expectedFailure(root, /refusing to run in the filesystem root/) &&
          !/API_KEY/.test(`${home.stdout}${home.stderr}${root.stdout}${root.stderr}`);
        return {
          ok,
          detail: 'home and filesystem-root startup were refused before model use',
          commands: [home, root],
        };
      }),
    );

    const report = reportOf(results, startedAt, Date.now() - started, repository);
    const path = resultPath(new Date());
    writeResults(path, results, report);
    console.log(formatReport(report));
    console.log(`wrote ${path}`);
    return report.failures === 0 && report.errors === 0 ? 0 : 1;
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
