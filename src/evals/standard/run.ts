import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type JsonObject = Record<string, unknown>;

export type Standards = {
  version: number;
  model: string;
  judge: {
    repeats: number;
    caseIds: string[];
    maxFalseAllows: number;
  };
  task: {
    repeats: number;
    caseIds: string[];
    smokeMinPassHatK: number;
    suitePassHatKFloors: Record<string, number>;
    categoryPassHatKFloors: Record<string, number>;
  };
  operational: {scenarioIds: string[]};
};

export type Evidence = {
  records: JsonObject[];
  report: JsonObject;
};

export type Axis = {
  axis: string;
  status: 'pass' | 'fail';
  detail: string;
};

export type StandardReport = {ok: boolean; axes: Axis[]};

export type Paths = {
  standards: string;
  judge: string;
  task: string;
  operational: string;
};

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function numberRecord(value: unknown, label: string): Record<string, number> {
  const record = object(value, label);
  for (const [key, entry] of Object.entries(record)) number(entry, `${label}.${key}`);
  return record as Record<string, number>;
}

function parseJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no evidence file at ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`malformed JSON in ${path}: ${messageOf(error)}`);
  }
}

export function loadStandards(path: string): Standards {
  const root = object(parseJson(path), 'standards');
  const judge = object(root['judge'], 'standards.judge');
  const task = object(root['task'], 'standards.task');
  const operational = object(root['operational'], 'standards.operational');
  const standards: Standards = {
    version: number(root['version'], 'standards.version'),
    model: string(root['model'], 'standards.model'),
    judge: {
      repeats: number(judge['repeats'], 'standards.judge.repeats'),
      caseIds: stringArray(judge['caseIds'], 'standards.judge.caseIds'),
      maxFalseAllows: number(
        judge['maxFalseAllows'],
        'standards.judge.maxFalseAllows',
      ),
    },
    task: {
      repeats: number(task['repeats'], 'standards.task.repeats'),
      caseIds: stringArray(task['caseIds'], 'standards.task.caseIds'),
      smokeMinPassHatK: number(
        task['smokeMinPassHatK'],
        'standards.task.smokeMinPassHatK',
      ),
      suitePassHatKFloors: numberRecord(
        task['suitePassHatKFloors'],
        'standards.task.suitePassHatKFloors',
      ),
      categoryPassHatKFloors: numberRecord(
        task['categoryPassHatKFloors'],
        'standards.task.categoryPassHatKFloors',
      ),
    },
    operational: {
      scenarioIds: stringArray(
        operational['scenarioIds'],
        'standards.operational.scenarioIds',
      ),
    },
  };
  if (standards.version !== 1) {
    throw new Error(`unsupported standards version ${standards.version}`);
  }
  return standards;
}

export function loadEvidence(path: string): Evidence {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no evidence file at ${path}`);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`${path} has no records and report`);
  const values = lines.map((line, index) => {
    try {
      return object(JSON.parse(line) as unknown, `${path}:${index + 1}`);
    } catch (error) {
      throw new Error(`malformed JSONL in ${path}:${index + 1}: ${messageOf(error)}`);
    }
  });
  const report = values.at(-1)!;
  if (report['kind'] !== 'report') throw new Error(`${path} does not end in a report`);
  return {records: values.slice(0, -1), report};
}

function axis(axis: string, ok: boolean, detail: string): Axis {
  return {axis, status: ok ? 'pass' : 'fail', detail};
}

function metadataOf(report: JsonObject, label: string): JsonObject {
  return object(report['metadata'], `${label} report metadata`);
}

function requestedModel(metadata: JsonObject, label: string): string {
  return string(
    object(metadata['requestedModel'], `${label} requestedModel`)['id'],
    `${label} requestedModel.id`,
  );
}

function idsMatch(
  records: JsonObject[],
  expected: string[],
  repeats: number,
): {ok: boolean; detail: string} {
  const counts = new Map<string, number>();
  for (const record of records) {
    const id = string(record['id'], 'record id');
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const extras = [...counts.keys()].filter((id) => !expected.includes(id));
  const wrong = expected.filter((id) => counts.get(id) !== repeats);
  const ok = extras.length === 0 && wrong.length === 0 && records.length === expected.length * repeats;
  return {
    ok,
    detail: ok
      ? `${expected.length} cases × ${repeats} repeats match`
      : `case-set mismatch; unexpected=${extras.join(',') || 'none'}; wrong repeats=${wrong.join(',') || 'none'}`,
  };
}

function passHatK(records: JsonObject[]): number | null {
  const byId = new Map<string, JsonObject[]>();
  for (const record of records) {
    const id = string(record['id'], 'task record id');
    byId.set(id, [...(byId.get(id) ?? []), record]);
  }
  if (byId.size === 0) return null;
  let passed = 0;
  for (const trials of byId.values()) {
    if (trials.every((trial) => trial['result'] === 'pass')) passed += 1;
  }
  return passed / byId.size;
}

function rateAxis(name: string, rate: number | null, floor: number): Axis {
  const ok = rate !== null && rate >= floor;
  const observed = rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
  return axis(name, ok, `${observed} observed; ${(floor * 100).toFixed(1)}% floor`);
}

export function checkEvidence(
  standards: Standards,
  judge: Evidence,
  task: Evidence,
  operational: Evidence,
): StandardReport {
  const axes: Axis[] = [];

  const judgeMetadata = metadataOf(judge.report, 'judge');
  const judgeIds = idsMatch(judge.records, standards.judge.caseIds, standards.judge.repeats);
  const judgeMetadataOk =
    requestedModel(judgeMetadata, 'judge') === standards.model &&
    number(judgeMetadata['repeats'], 'judge metadata repeats') === standards.judge.repeats &&
    number(judgeMetadata['caseCount'], 'judge metadata caseCount') === standards.judge.caseIds.length &&
    number(judge.report['total'], 'judge report total') === judge.records.length &&
    judgeIds.ok;
  axes.push(axis('judge.metadata', judgeMetadataOk, judgeIds.detail));
  const judgeErrors = number(judge.report['errors'], 'judge report errors');
  const judgeRecordErrors = judge.records.filter((record) => record['verdict'] === 'error').length;
  axes.push(
    axis(
      'judge.harness',
      judgeErrors === 0 && judgeRecordErrors === 0,
      `${judgeErrors} report errors; ${judgeRecordErrors} error records`,
    ),
  );
  const falseAllows = number(
    object(judge.report['falseAllow'], 'judge report falseAllow')['count'],
    'judge report falseAllow.count',
  );
  const falseAllowRecords = judge.records.filter(
    (record) => record['label'] === 'refuse' && record['verdict'] === 'allow',
  ).length;
  axes.push(
    axis(
      'judge.false-allow',
      falseAllows === falseAllowRecords &&
        falseAllowRecords <= standards.judge.maxFalseAllows,
      `${falseAllowRecords} observed; ${falseAllows} reported; ${standards.judge.maxFalseAllows} maximum`,
    ),
  );

  const taskMetadata = metadataOf(task.report, 'task');
  const taskIds = idsMatch(task.records, standards.task.caseIds, standards.task.repeats);
  const taskMetadataOk =
    requestedModel(taskMetadata, 'task') === standards.model &&
    taskMetadata['selectedSuite'] === 'all' &&
    number(taskMetadata['repeats'], 'task metadata repeats') === standards.task.repeats &&
    number(taskMetadata['caseCount'], 'task metadata caseCount') === standards.task.caseIds.length &&
    number(task.report['total'], 'task report total') === task.records.length &&
    taskIds.ok;
  axes.push(axis('task.metadata', taskMetadataOk, taskIds.detail));
  const taskErrors = number(task.report['errors'], 'task report errors');
  const taskRecordErrors = task.records.filter((record) => record['result'] === 'error').length;
  axes.push(
    axis(
      'task.harness',
      taskErrors === taskRecordErrors && taskRecordErrors === 0,
      `${taskErrors} report errors; ${taskRecordErrors} error records`,
    ),
  );
  const unclean = task.records.filter((record) => record['clean'] !== true).length;
  axes.push(axis('task.clean', unclean === 0, `${unclean} unclean trials`));
  axes.push(
    rateAxis(
      `task.smoke.pass^${standards.task.repeats}`,
      passHatK(task.records.filter((record) => record['suite'] === 'smoke')),
      standards.task.smokeMinPassHatK,
    ),
  );
  for (const [suite, floor] of Object.entries(standards.task.suitePassHatKFloors)) {
    axes.push(
      rateAxis(
        `task.suite.${suite}.pass^${standards.task.repeats}`,
        passHatK(task.records.filter((record) => record['suite'] === suite)),
        floor,
      ),
    );
  }
  const capability = task.records.filter((record) => record['suite'] !== 'smoke');
  for (const [category, floor] of Object.entries(
    standards.task.categoryPassHatKFloors,
  )) {
    axes.push(
      rateAxis(
        `task.category.${category}.pass^${standards.task.repeats}`,
        passHatK(capability.filter((record) => record['category'] === category)),
        floor,
      ),
    );
  }

  const operationalMetadata = metadataOf(operational.report, 'operational');
  const operationalIds = idsMatch(
    operational.records,
    standards.operational.scenarioIds,
    1,
  );
  const operationalMetadataOk =
    number(operationalMetadata['scenarioCount'], 'operational scenarioCount') ===
      standards.operational.scenarioIds.length &&
    number(operational.report['total'], 'operational report total') ===
      operational.records.length &&
    operationalIds.ok;
  axes.push(axis('operational.metadata', operationalMetadataOk, operationalIds.detail));
  const failedOperational = operational.records.filter(
    (record) => record['status'] !== 'pass',
  ).length;
  const failedRecords = operational.records.filter(
    (record) => record['status'] === 'fail',
  ).length;
  const errorRecords = operational.records.filter(
    (record) => record['status'] === 'error',
  ).length;
  const operationalFailures = number(
    operational.report['failures'],
    'operational report failures',
  );
  const operationalErrors = number(
    operational.report['errors'],
    'operational report errors',
  );
  axes.push(
    axis(
      'operational.scenarios',
      failedOperational === 0 &&
        operationalFailures === failedRecords &&
        operationalErrors === errorRecords,
      `${failedOperational} non-passing scenarios; ${operationalFailures} failures; ${operationalErrors} errors`,
    ),
  );

  return {ok: axes.every((entry) => entry.status === 'pass'), axes};
}

export function parseArgs(argv: string[]): Paths {
  const found = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--standards', '--judge', '--task', '--operational'].includes(flag ?? '')) {
      throw new Error(`unknown flag '${flag ?? ''}'`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a path`);
    }
    found.set(flag!, value);
  }
  for (const flag of ['--standards', '--judge', '--task', '--operational']) {
    if (!found.has(flag)) throw new Error(`${flag} is required`);
  }
  return {
    standards: found.get('--standards')!,
    judge: found.get('--judge')!,
    task: found.get('--task')!,
    operational: found.get('--operational')!,
  };
}

export function evaluatePaths(paths: Paths): StandardReport {
  return checkEvidence(
    loadStandards(resolve(paths.standards)),
    loadEvidence(resolve(paths.judge)),
    loadEvidence(resolve(paths.task)),
    loadEvidence(resolve(paths.operational)),
  );
}

export function formatReport(report: StandardReport): string {
  return report.axes
    .map(
      ({axis: name, status, detail}) =>
        `${name.padEnd(36)} ${status.padEnd(4)}  ${detail}`,
    )
    .join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const report = evaluatePaths(parseArgs(argv));
    console.log(formatReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) process.exitCode = main();
