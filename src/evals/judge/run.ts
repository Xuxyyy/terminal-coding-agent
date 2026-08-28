import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient, judgeModelFor, type ModelChoice} from '../../core/client.js';
import {
  JUDGE_MAX_TOKENS,
  JUDGE_TIMEOUT,
  judgeMessages,
  judgeVerdict,
} from '../../core/permission/judge.js';
import {withRetry, type RetryOptions} from '../../core/retry.js';
import {parseCases, toJudgeInput, type EvalCase} from './cases.js';
import {formatReport, score, type Outcome, type Report} from './score.js';

export const DEFAULT_CASES = 'evals/cases/judge.jsonl';
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const RESULTS_DIR = 'evals/results';

export type RunOptions = {
  repeats: number;
  concurrency: number;
  maxSeconds: number;
};

export type Args = RunOptions & {cases: string; limit: number | null};

export const DEFAULTS: Args = {
  cases: DEFAULT_CASES,
  repeats: 3,
  concurrency: 4,
  maxSeconds: 600,
  limit: null,
};

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
    } else if (flag === '--concurrency') {
      args.concurrency = positive(flag, value);
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

export function limitCases(cases: EvalCase[], limit: number | null): EvalCase[] {
  return limit === null ? cases : cases.slice(0, limit);
}

export function loadCases(path: string): EvalCase[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no case file at ${path}`);
  }
  const cases = parseCases(text);
  if (cases.length === 0) throw new Error(`${path} holds no cases`);
  return cases;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length === 0 ? 'the call failed without a message' : text;
}

export async function runCase(
  choice: ModelChoice,
  c: EvalCase,
  signal: AbortSignal,
  retry: Partial<RetryOptions> = {},
): Promise<Outcome> {
  const messages = judgeMessages(toJudgeInput(c));
  const started = Date.now();
  let attempts = 0;

  const base = {id: c.id, category: c.category, label: c.label};
  try {
    const reply = await withRetry(
      async () => {
        attempts += 1;
        return choice.client.chat.completions.create(
          {
            model: choice.model,
            messages,
            stream: false,
            max_tokens: JUDGE_MAX_TOKENS,
          },
          {signal: AbortSignal.any([signal, AbortSignal.timeout(JUDGE_TIMEOUT)])},
        );
      },
      {signal, ...retry},
    );
    const verdict = judgeVerdict(reply.choices[0]?.message?.content ?? '');
    return {...base, verdict, attempts, ms: Date.now() - started};
  } catch (error) {
    return {
      ...base,
      verdict: 'error',
      attempts,
      ms: Date.now() - started,
      error: messageOf(error),
    };
  }
}

export async function runAll(
  choice: ModelChoice,
  cases: EvalCase[],
  options: RunOptions,
  signal: AbortSignal,
  retry: Partial<RetryOptions> = {},
): Promise<Outcome[]> {
  const jobs: EvalCase[] = [];
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    jobs.push(...cases);
  }

  const deadline = AbortSignal.timeout(options.maxSeconds * 1_000);
  const stop = AbortSignal.any([signal, deadline]);
  const outcomes = new Array<Outcome>(jobs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= jobs.length) return;
      next += 1;
      const c = jobs[index]!;
      outcomes[index] = stop.aborted
        ? {
            id: c.id,
            category: c.category,
            label: c.label,
            verdict: 'error',
            attempts: 0,
            ms: 0,
            error: 'the run stopped before this case ran',
          }
        : await runCase(choice, c, stop, retry);
    }
  };

  const size = Math.max(1, Math.min(options.concurrency, jobs.length));
  await Promise.all(Array.from({length: size}, worker));
  return outcomes;
}

function resultPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), RESULTS_DIR, `${stamp}.jsonl`);
}

function writeResults(path: string, outcomes: Outcome[], report: Report): void {
  const lines = [
    ...outcomes.map((outcome) => JSON.stringify(outcome)),
    JSON.stringify({kind: 'report', ...report}),
  ];
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${lines.join('\n')}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  let cases: EvalCase[];
  try {
    args = parseArgs(argv);
    cases = limitCases(
      loadCases(resolve(process.cwd(), args.cases)),
      args.limit,
    );
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }

  const choice = createClient(
    judgeModelFor(process.env['ACC_EVAL_MODEL'] ?? DEFAULT_MODEL),
  );
  const planned = cases.length * args.repeats;
  console.log(
    `${cases.length} cases × ${args.repeats} repeats = ${planned} calls ` +
      `to ${choice.model} at concurrency ${args.concurrency}`,
  );

  const started = Date.now();
  const outcomes = await runAll(
    choice,
    cases,
    args,
    new AbortController().signal,
  );
  const elapsed = (Date.now() - started) / 1_000;

  const report = score(outcomes);
  const path = resultPath(new Date());
  writeResults(path, outcomes, report);

  const attempts = outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0);
  console.log('');
  console.log(formatReport(report));
  console.log('');
  console.log(
    `${elapsed.toFixed(1)}s wall clock, ` +
      `${(outcomes.length / elapsed).toFixed(2)} calls/s, ` +
      `${attempts} model calls made`,
  );
  console.log(`wrote ${path}`);

  if (report.errors > 0) {
    console.error(`${report.errors} outcomes were errors — the run is not usable`);
    return 1;
  }
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
