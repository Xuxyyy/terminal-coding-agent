import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Trial} from '../task/run.js';
import {writeResults} from '../task/run.js';
import {score, type Report, type RunMetadata} from '../task/score.js';
import {loadEvidence, type Evidence} from './run.js';

type TaskEvidence = {trials: Trial[]; report: Report & {metadata: RunMetadata}};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskEvidence(evidence: Evidence, label: string): TaskEvidence {
  const metadata = evidence.report['metadata'];
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${label} task report has no metadata`);
  }
  return {
    trials: evidence.records as Trial[],
    report: evidence.report as Report & {metadata: RunMetadata},
  };
}

function counts(records: Array<{id: string}>): Map<string, number> {
  const found = new Map<string, number>();
  for (const record of records) found.set(record.id, (found.get(record.id) ?? 0) + 1);
  return found;
}

function validateRepeats(
  records: Array<{id: string}>,
  repeats: number,
  label: string,
): void {
  for (const [id, count] of counts(records)) {
    if (count !== repeats) {
      throw new Error(`${label} case '${id}' has ${count} trials, expected ${repeats}`);
    }
  }
}

export function replaceCaseTrials<T extends {id: string}>(
  base: T[],
  replacement: T[],
  repeats: number,
): {records: T[]; replacedCaseIds: string[]} {
  validateRepeats(base, repeats, 'base');
  validateRepeats(replacement, repeats, 'replacement');
  const baseCounts = counts(base);
  const replacementIds = [...counts(replacement).keys()].sort();
  for (const id of replacementIds) {
    if (!baseCounts.has(id)) throw new Error(`replacement case '${id}' is absent from base`);
  }
  const queues = new Map<string, T[]>();
  for (const record of replacement) {
    queues.set(record.id, [...(queues.get(record.id) ?? []), record]);
  }
  const records = base.map((record) => queues.get(record.id)?.shift() ?? record);
  if ([...queues.values()].some((queue) => queue.length > 0)) {
    throw new Error('replacement trials were not consumed exactly once');
  }
  return {records, replacedCaseIds: replacementIds};
}

function matchingRunMetadata(base: RunMetadata, replacement: RunMetadata): void {
  const fields: Array<keyof RunMetadata> = [
    'repeats',
    'selectedSuite',
    'node',
    'platform',
  ];
  for (const field of fields) {
    if (base[field] !== replacement[field]) {
      throw new Error(`task evidence metadata differs at ${field}`);
    }
  }
  if (base.requestedModel.id !== replacement.requestedModel.id) {
    throw new Error('task evidence requested models differ');
  }
  if (base.git.revision !== replacement.git.revision) {
    throw new Error('task evidence Git revisions differ');
  }
  if (base.selectedSuite !== 'all') throw new Error('base task evidence is not suite all');
}

export function composeTaskEvidence(
  basePath: string,
  replacementPath: string,
  outputPath: string,
): Report {
  const base = taskEvidence(loadEvidence(basePath), 'base');
  const replacement = taskEvidence(loadEvidence(replacementPath), 'replacement');
  matchingRunMetadata(base.report.metadata, replacement.report.metadata);
  const {records, replacedCaseIds} = replaceCaseTrials(
    base.trials,
    replacement.trials,
    base.report.repeats,
  );
  const metadata: RunMetadata = {
    ...base.report.metadata,
    elapsedMs: base.report.metadata.elapsedMs + replacement.report.metadata.elapsedMs,
    composition: {
      method: 'replace-case-trials',
      baseResult: basename(basePath),
      replacementResult: basename(replacementPath),
      replacedCaseIds,
    },
  };
  const report = score(records, base.report.repeats, metadata);
  writeResults(outputPath, records, report);
  return report;
}

function parseArgs(argv: string[]): {
  base: string;
  replacement: string;
  output: string;
} {
  const found = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--base', '--replacement', '--output'].includes(flag ?? '')) {
      throw new Error(`unknown flag '${flag ?? ''}'`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path`);
    found.set(flag!, value);
  }
  for (const flag of ['--base', '--replacement', '--output']) {
    if (!found.has(flag)) throw new Error(`${flag} is required`);
  }
  return {
    base: resolve(found.get('--base')!),
    replacement: resolve(found.get('--replacement')!),
    output: resolve(found.get('--output')!),
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const report = composeTaskEvidence(args.base, args.replacement, args.output);
    console.log(
      `${report.total} composed trials: ${report.solved.count} solved, ` +
        `${report.clean.count} clean, ${report.errors} errors`,
    );
    console.log(`wrote ${args.output}`);
    return report.errors === 0 ? 0 : 1;
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) process.exitCode = main();
