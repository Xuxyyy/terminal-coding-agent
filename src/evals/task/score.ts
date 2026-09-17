import type {StopReason} from '../../core/headless/run.js';
import {
  CATEGORIES,
  SUITES,
  type Category,
  type TaskSuite,
} from './cases.js';
import type {Changes} from './fixture.js';
import type {CheckResult} from './grade.js';
import type {Metrics} from './metrics.js';

export type Result = 'pass' | 'fail' | 'error';

export type Outcome = {
  id: string;
  suite: TaskSuite;
  category: Category;
  result: Result;
  solved: boolean;
  clean: boolean;
  stopped: StopReason;
  metrics: Metrics;
  checks: CheckResult[];
  changes: Changes;
  outside: string[];
  error?: string;
};

export type Rate = {count: number; of: number; rate: number | null};

export type CategoryReport = {
  category: Category;
  total: number;
  errors: number;
  scored: number;
  solved: number;
  clean: number;
};

export type CaseReport = {
  id: string;
  suite: TaskSuite;
  category: Category;
  total: number;
  errors: number;
  passes: number;
  steps: number | null;
  toolErrors: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type SuiteReport = {
  suite: TaskSuite;
  total: number;
  errors: number;
  scored: number;
  solved: number;
  clean: number;
  passHatK: Rate;
};

export type RunMetadata = {
  requestedModel: {id: string; label: string};
  startedAt: string;
  elapsedMs: number;
  git: {revision: string; dirty: boolean};
  node: string;
  platform: string;
  selectedSuite: TaskSuite | 'all';
  repeats: number;
  caseCount: number;
};

export type Report = {
  repeats: number;
  total: number;
  scored: number;
  errors: number;
  solved: Rate;
  clean: Rate;
  passHatK: Rate;
  byCase: CaseReport[];
  bySuite: SuiteReport[];
  byCategory: CategoryReport[];
  unstable: string[];
  metadata?: RunMetadata;
};

function rateOf(count: number, of: number): Rate {
  return {count, of, rate: of === 0 ? null : count / of};
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function idsInOrder(outcomes: Outcome[]): string[] {
  const seen: string[] = [];
  for (const outcome of outcomes) {
    if (!seen.includes(outcome.id)) seen.push(outcome.id);
  }
  return seen;
}

function passHatKOf(outcomes: Outcome[]): Rate {
  let withTrials = 0;
  let allPassed = 0;
  for (const id of idsInOrder(outcomes)) {
    const kept = outcomes.filter((o) => o.id === id && o.result !== 'error');
    if (kept.length === 0) continue;
    withTrials += 1;
    if (kept.every((o) => o.result === 'pass')) allPassed += 1;
  }
  return rateOf(allPassed, withTrials);
}

export function score(
  outcomes: Outcome[],
  repeats: number,
  metadata?: RunMetadata,
): Report {
  const scored = outcomes.filter((o) => o.result !== 'error');
  const errors = outcomes.length - scored.length;

  const byCase: CaseReport[] = [];
  let casesWithTrials = 0;
  let casesAllPassed = 0;
  for (const id of idsInOrder(outcomes)) {
    const trials = outcomes.filter((o) => o.id === id);
    const kept = trials.filter((o) => o.result !== 'error');
    if (kept.length > 0) {
      casesWithTrials += 1;
      if (kept.every((o) => o.result === 'pass')) casesAllPassed += 1;
    }
    byCase.push({
      id,
      suite: trials[0]!.suite,
      category: trials[0]!.category,
      total: trials.length,
      errors: trials.length - kept.length,
      passes: kept.filter((o) => o.result === 'pass').length,
      steps: median(kept.map((o) => o.metrics.steps)),
      toolErrors: median(kept.map((o) => o.metrics.toolErrors)),
      promptTokens: median(kept.map((o) => o.metrics.promptTokens)),
      completionTokens: median(kept.map((o) => o.metrics.completionTokens)),
      totalTokens: median(kept.map((o) => o.metrics.totalTokens)),
    });
  }

  const bySuite: SuiteReport[] = [];
  for (const suite of SUITES) {
    const inSuite = outcomes.filter((o) => o.suite === suite);
    if (inSuite.length === 0) continue;
    const kept = inSuite.filter((o) => o.result !== 'error');
    bySuite.push({
      suite,
      total: inSuite.length,
      errors: inSuite.length - kept.length,
      scored: kept.length,
      solved: kept.filter((o) => o.solved).length,
      clean: kept.filter((o) => o.clean).length,
      passHatK: passHatKOf(inSuite),
    });
  }

  const byCategory: CategoryReport[] = [];
  for (const category of CATEGORIES) {
    const inCategory = outcomes.filter((o) => o.category === category);
    if (inCategory.length === 0) continue;
    const kept = inCategory.filter((o) => o.result !== 'error');
    byCategory.push({
      category,
      total: inCategory.length,
      errors: inCategory.length - kept.length,
      scored: kept.length,
      solved: kept.filter((o) => o.solved).length,
      clean: kept.filter((o) => o.clean).length,
    });
  }

  const resultsById = new Map<string, Set<Result>>();
  for (const outcome of scored) {
    const seen = resultsById.get(outcome.id) ?? new Set<Result>();
    seen.add(outcome.result);
    resultsById.set(outcome.id, seen);
  }
  const unstable = [...resultsById.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([id]) => id)
    .sort();

  return {
    repeats,
    total: outcomes.length,
    scored: scored.length,
    errors,
    solved: rateOf(scored.filter((o) => o.solved).length, scored.length),
    clean: rateOf(scored.filter((o) => o.clean).length, scored.length),
    passHatK: rateOf(casesAllPassed, casesWithTrials),
    byCase,
    bySuite,
    byCategory,
    unstable,
    ...(metadata === undefined ? {} : {metadata}),
  };
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function fraction(rate: Rate): string {
  return `${rate.count}/${rate.of}`;
}

function number(value: number | null): string {
  if (value === null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function table(headings: string[], rows: string[][]): string[] {
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
      )
      .join('  ')
      .trimEnd();
  return [line(headings), ...rows.map(line)];
}

const CASE_HEADINGS = [
  'case',
  'suite',
  'n',
  'err',
  'pass',
  'steps',
  'tool-err',
  'prompt',
  'completion',
  'total',
];
const SUITE_HEADINGS = ['suite', 'n', 'err', 'solved', 'clean', 'pass^k'];
const CATEGORY_HEADINGS = ['category', 'n', 'err', 'solved', 'clean'];

export function formatReport(report: Report): string {
  const lines = [
    `${report.total} trials, ${report.scored} scored, ${report.errors} excluded as errors`,
    '',
    `solved   ${fraction(report.solved).padEnd(9)}${percent(report.solved.rate).padStart(6)}  every check passed`,
    `clean    ${fraction(report.clean).padEnd(9)}${percent(report.clean.rate).padStart(6)}  nothing written outside the allowed set`,
    `pass^${report.repeats}   ${fraction(report.passHatK).padEnd(9)}${percent(report.passHatK.rate).padStart(6)}  cases where every trial passed`,
    '',
    ...table(
      CASE_HEADINGS,
      report.byCase.map((entry) => [
        entry.id,
        entry.suite,
        String(entry.total),
        String(entry.errors),
        String(entry.passes),
        number(entry.steps),
        number(entry.toolErrors),
        number(entry.promptTokens),
        number(entry.completionTokens),
        number(entry.totalTokens),
      ]),
    ),
    '',
    ...table(
      SUITE_HEADINGS,
      report.bySuite.map((entry) => [
        entry.suite,
        String(entry.total),
        String(entry.errors),
        String(entry.solved),
        String(entry.clean),
        fraction(entry.passHatK),
      ]),
    ),
    '',
    ...table(
      CATEGORY_HEADINGS,
      report.byCategory.map((entry) => [
        entry.category,
        String(entry.total),
        String(entry.errors),
        String(entry.solved),
        String(entry.clean),
      ]),
    ),
    '',
    report.unstable.length === 0
      ? 'no case disagreed with its own repeats'
      : `repeats disagreed on ${report.unstable.length}: ${report.unstable.join(', ')}`,
  ];
  return lines.join('\n');
}
