import type {StopReason} from '../../core/headless/run.js';
import {CATEGORIES, type Category} from './cases.js';
import type {Changes} from './fixture.js';
import type {CheckResult} from './grade.js';
import type {Metrics} from './metrics.js';

export type Result = 'pass' | 'fail' | 'error';

export type Outcome = {
  id: string;
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
  category: Category;
  total: number;
  errors: number;
  passes: number;
  steps: number | null;
  toolErrors: number | null;
  tokens: number | null;
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
  byCategory: CategoryReport[];
  unstable: string[];
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

export function score(outcomes: Outcome[], repeats: number): Report {
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
      category: trials[0]!.category,
      total: trials.length,
      errors: trials.length - kept.length,
      passes: kept.filter((o) => o.result === 'pass').length,
      steps: median(kept.map((o) => o.metrics.steps)),
      toolErrors: median(kept.map((o) => o.metrics.toolErrors)),
      tokens: median(kept.map((o) => o.metrics.tokens)),
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
    byCategory,
    unstable,
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

const CASE_HEADINGS = ['case', 'n', 'err', 'pass', 'steps', 'tool-err', 'tokens'];
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
        String(entry.total),
        String(entry.errors),
        String(entry.passes),
        number(entry.steps),
        number(entry.toolErrors),
        number(entry.tokens),
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
