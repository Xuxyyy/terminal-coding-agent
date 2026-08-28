import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient, type ModelChoice} from '../../core/client.js';
import type {RecordedPrompt} from '../../core/headless/host.js';
import {
  runHeadless,
  type HeadlessResult,
  type StopReason,
} from '../../core/headless/run.js';
import {loadSettings, settingsFiles} from '../../core/settings.js';
import {loadCases, type TaskCase} from './cases.js';
import {
  buildFixture,
  changes,
  removeFixture,
  snapshot,
  type Changes,
} from './fixture.js';
import {outsideAllowed, runChecks, verdict, type CheckResult} from './grade.js';
import {metricsOf, transcriptOf, type Metrics, type TranscriptCall} from './metrics.js';
import {
  formatReport,
  score,
  type Outcome,
  type Report,
  type Result,
} from './score.js';

export const DEFAULT_CASES = 'evals/cases/task';
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const RESULTS_DIR = 'evals/results/task';
export const HOME_PREFIX = 'acc-task-home-';

export type Args = {
  cases: string;
  repeats: number;
  limit: number | null;
  maxSeconds: number | null;
};

export const DEFAULTS: Args = {
  cases: DEFAULT_CASES,
  repeats: 3,
  limit: null,
  maxSeconds: null,
};

export type Trial = Outcome & {
  text: string;
  prompts: RecordedPrompt[];
  calls: TranscriptCall[];
};

const NO_METRICS: Metrics = {
  steps: 0,
  toolCalls: 0,
  toolErrors: 0,
  tokens: 0,
  prompts: 0,
};

const NO_CHANGES: Changes = {added: [], modified: [], deleted: []};

export function resultOf(stopped: StopReason, solved: boolean, clean: boolean): Result {
  if (stopped === 'error') return 'error';
  if (stopped === 'timeout') return 'fail';
  return solved && clean ? 'pass' : 'fail';
}

function positive(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} needs a positive whole number, got '${raw ?? ''}'`);
  }
  return value;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {...DEFAULTS};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === '--cases') {
      if (value === undefined) throw new Error('--cases needs a path');
      args.cases = value;
    } else if (flag === '--repeats') {
      args.repeats = positive(flag, value);
    } else if (flag === '--limit') {
      args.limit = positive(flag, value);
    } else if (flag === '--max-seconds') {
      args.maxSeconds = positive(flag, value);
    } else {
      throw new Error(`unknown flag '${flag}'`);
    }
    i += 1;
  }
  return args;
}

export function limitCases(cases: TaskCase[], limit: number | null): TaskCase[] {
  return limit === null ? cases : cases.slice(0, limit);
}

export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length === 0 ? 'the run failed without a message' : text;
}

export function pinSettings(c: TaskCase, fixtureRoot: string, accHome: string): void {
  process.env.ACC_HOME = accHome;
  mkdirSync(accHome, {recursive: true});
  writeFileSync(
    join(accHome, 'settings.json'),
    `${JSON.stringify({permission_mode: c.task.mode}, null, 2)}\n`,
    {mode: 0o600},
  );
  loadSettings(settingsFiles(fixtureRoot));
}

export function outcomeOf(
  c: TaskCase,
  result: HeadlessResult,
  before: Map<string, string>,
  after: Map<string, string>,
  checks: CheckResult[],
): Trial {
  const moved = changes(before, after);
  const outside = outsideAllowed(moved, c.grade.allowedWrites);
  const {solved, clean} = verdict(checks, outside, result.stopped);
  const transcript = transcriptOf(result.events);
  return {
    id: c.id,
    category: c.category,
    result: resultOf(result.stopped, solved, clean),
    solved,
    clean,
    stopped: result.stopped,
    metrics: metricsOf(result.events, result.prompts),
    checks,
    changes: moved,
    outside,
    text: transcript.text,
    prompts: result.prompts,
    calls: transcript.calls,
    ...(result.error === undefined ? {} : {error: result.error}),
  };
}

export function errorTrial(c: TaskCase, error: string): Trial {
  return {
    id: c.id,
    category: c.category,
    result: 'error',
    solved: false,
    clean: false,
    stopped: 'error',
    metrics: NO_METRICS,
    checks: [],
    changes: NO_CHANGES,
    outside: [],
    text: '',
    prompts: [],
    calls: [],
    error,
  };
}

export async function runOne(
  c: TaskCase,
  choice: ModelChoice,
  maxSeconds: number | null,
): Promise<Trial> {
  let root: string | null = null;
  let home: string | null = null;
  try {
    root = buildFixture(c);
    home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
    pinSettings(c, root, home);
    const before = snapshot(root);
    const result = await runHeadless({
      root,
      task: c.task.prompt,
      choice,
      policy: c.task.policy,
      maxSeconds: maxSeconds ?? c.task.maxSeconds,
    });
    const after = snapshot(root);
    const checks = runChecks(c, root, result.text, before, result.prompts);
    return outcomeOf(c, result, before, after, checks);
  } catch (error) {
    return errorTrial(c, messageOf(error));
  } finally {
    if (root) removeFixture(root);
    if (home) removeFixture(home);
  }
}

export async function runAll(
  cases: TaskCase[],
  repeats: number,
  choice: ModelChoice,
  maxSeconds: number | null,
): Promise<Trial[]> {
  const trials: Trial[] = [];
  const planned = cases.length * repeats;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const c of cases) {
      const started = Date.now();
      const trial = await runOne(c, choice, maxSeconds);
      const seconds = ((Date.now() - started) / 1_000).toFixed(1);
      console.log(
        `[${trials.length + 1}/${planned}] ${c.id} trial ${repeat} — ` +
          `${trial.result} (${trial.metrics.steps} steps, ` +
          `${trial.metrics.tokens} tokens, ${seconds}s)` +
          (trial.error === undefined ? '' : ` — ${trial.error}`),
      );
      trials.push(trial);
    }
  }
  return trials;
}

export function resultPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), RESULTS_DIR, `${stamp}.jsonl`);
}

export function writeResults(path: string, trials: Trial[], report: Report): void {
  const lines = [
    ...trials.map((trial) => JSON.stringify(trial)),
    JSON.stringify({kind: 'report', ...report}),
  ];
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${lines.join('\n')}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  let cases: TaskCase[];
  try {
    args = parseArgs(argv);
    cases = limitCases(loadCases(resolve(process.cwd(), args.cases)), args.limit);
    if (cases.length === 0) throw new Error(`${args.cases} holds no cases`);
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }

  let choice: ModelChoice;
  try {
    choice = createClient(process.env['ACC_EVAL_MODEL'] ?? DEFAULT_MODEL);
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }

  const planned = cases.length * args.repeats;
  console.log(
    `${cases.length} cases × ${args.repeats} repeats = ${planned} trials ` +
      `against ${choice.model}, one at a time`,
  );

  const started = Date.now();
  const trials = await runAll(cases, args.repeats, choice, args.maxSeconds);
  const elapsed = (Date.now() - started) / 1_000;

  const report = score(trials, args.repeats);
  const path = resultPath(new Date());
  writeResults(path, trials, report);

  const tokens = trials.reduce((sum, trial) => sum + trial.metrics.tokens, 0);
  console.log('');
  console.log(formatReport(report));
  console.log('');
  console.log(`${elapsed.toFixed(1)}s wall clock, ${tokens} tokens over ${planned} trials`);
  console.log(`wrote ${path}`);

  if (report.errors > 0) {
    console.error(`${report.errors} trials were errors — the run is not usable`);
    return 1;
  }
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
