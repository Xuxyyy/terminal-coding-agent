import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  checkEvidence,
  loadEvidence,
  parseArgs,
  type Evidence,
  type StandardReport,
  type Standards,
} from './run.js';

const standards: Standards = {
  version: 1,
  model: 'test-model',
  judge: {repeats: 3, caseIds: ['judge-1'], maxFalseAllows: 0},
  task: {
    repeats: 3,
    caseIds: ['smoke-1', 'focused-1', 'workflow-1'],
    smokeMinPassHatK: 1,
    suitePassHatKFloors: {focused: 1, workflow: 1},
    categoryPassHatKFloors: {edit: 1, create: 1},
  },
  operational: {scenarioIds: ['package-contents']},
};

function judgeEvidence(): Evidence {
  return {
    records: Array.from({length: 3}, () => ({
      id: 'judge-1',
      label: 'refuse',
      verdict: 'ask',
    })),
    report: {
      kind: 'report',
      total: 3,
      errors: 0,
      falseAllow: {count: 0, of: 3, rate: 0},
      metadata: {
        requestedModel: {id: 'test-model'},
        repeats: 3,
        caseCount: 1,
      },
    },
  };
}

function taskEvidence(): Evidence {
  const cases = [
    {id: 'smoke-1', suite: 'smoke', category: 'edit'},
    {id: 'focused-1', suite: 'focused', category: 'edit'},
    {id: 'workflow-1', suite: 'workflow', category: 'create'},
  ];
  return {
    records: cases.flatMap((entry) =>
      Array.from({length: 3}, () => ({
        ...entry,
        result: 'pass',
        clean: true,
      })),
    ),
    report: {
      kind: 'report',
      total: 9,
      errors: 0,
      metadata: {
        requestedModel: {id: 'test-model'},
        selectedSuite: 'all',
        repeats: 3,
        caseCount: 3,
      },
    },
  };
}

function operationalEvidence(): Evidence {
  return {
    records: [{kind: 'scenario', id: 'package-contents', status: 'pass'}],
    report: {
      kind: 'report',
      total: 1,
      failures: 0,
      errors: 0,
      metadata: {scenarioCount: 1},
    },
  };
}

function validEvidence(): [Evidence, Evidence, Evidence] {
  return [judgeEvidence(), taskEvidence(), operationalEvidence()];
}

function status(report: StandardReport, name: string): 'pass' | 'fail' {
  const found = report.axes.find((entry) => entry.axis === name);
  assert.ok(found, `missing axis ${name}`);
  return found.status;
}

test('a complete matching evidence set passes every independent axis', () => {
  const report = checkEvidence(standards, ...validEvidence());

  assert.equal(report.ok, true);
  assert.ok(report.axes.length > 8);
  assert.ok(report.axes.every((entry) => entry.status === 'pass'));
});

test('missing and malformed evidence fail before scoring', () => {
  const root = mkdtempSync(join(tmpdir(), 'acc-standard-test-'));
  try {
    assert.throws(() => loadEvidence(join(root, 'missing.jsonl')), /no evidence file/);
    const malformed = join(root, 'malformed.jsonl');
    writeFileSync(malformed, '{"id":"one"}\nnot-json\n');
    assert.throws(() => loadEvidence(malformed), /malformed JSONL/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('model mismatch fails judge and task metadata', () => {
  const [judge, task, operational] = validEvidence();
  (judge.report.metadata as Record<string, unknown>).requestedModel = {id: 'other'};
  (task.report.metadata as Record<string, unknown>).requestedModel = {id: 'other'};
  const report = checkEvidence(standards, judge, task, operational);

  assert.equal(status(report, 'judge.metadata'), 'fail');
  assert.equal(status(report, 'task.metadata'), 'fail');
});

test('case-set mismatch fails metadata even when totals still match', () => {
  const [judge, task, operational] = validEvidence();
  judge.records[0]!.id = 'unexpected';
  task.records[0]!.id = 'unexpected';
  const report = checkEvidence(standards, judge, task, operational);

  assert.equal(status(report, 'judge.metadata'), 'fail');
  assert.equal(status(report, 'task.metadata'), 'fail');
});

test('judge and task harness errors fail their own axes', () => {
  const [judge, task, operational] = validEvidence();
  judge.report.errors = 1;
  judge.records[0]!.verdict = 'error';
  task.report.errors = 1;
  task.records[0]!.result = 'error';
  const report = checkEvidence(standards, judge, task, operational);

  assert.equal(status(report, 'judge.harness'), 'fail');
  assert.equal(status(report, 'task.harness'), 'fail');
});

test('any false allow fails the safety axis', () => {
  const [judge, task, operational] = validEvidence();
  judge.report.falseAllow = {count: 1, of: 3, rate: 1 / 3};

  assert.equal(
    status(checkEvidence(standards, judge, task, operational), 'judge.false-allow'),
    'fail',
  );
});

test('any unclean task trial fails the clean axis', () => {
  const [judge, task, operational] = validEvidence();
  task.records[0]!.clean = false;

  assert.equal(
    status(checkEvidence(standards, judge, task, operational), 'task.clean'),
    'fail',
  );
});

test('a smoke regression fails the strict smoke pass^3 axis', () => {
  const [judge, task, operational] = validEvidence();
  task.records[0]!.result = 'fail';

  assert.equal(
    status(
      checkEvidence(standards, judge, task, operational),
      'task.smoke.pass^3',
    ),
    'fail',
  );
});

test('a capability regression fails its suite and category floors', () => {
  const [judge, task, operational] = validEvidence();
  task.records.find((record) => record.id === 'focused-1')!.result = 'fail';
  const report = checkEvidence(standards, judge, task, operational);

  assert.equal(status(report, 'task.suite.focused.pass^3'), 'fail');
  assert.equal(status(report, 'task.category.edit.pass^3'), 'fail');
});

test('an operational failure fails without hiding other axes', () => {
  const [judge, task, operational] = validEvidence();
  operational.records[0]!.status = 'fail';
  operational.report.failures = 1;
  const report = checkEvidence(standards, judge, task, operational);

  assert.equal(status(report, 'operational.scenarios'), 'fail');
  assert.equal(status(report, 'judge.false-allow'), 'pass');
});

test('all four evidence paths are explicit and required', () => {
  assert.deepEqual(
    parseArgs([
      '--standards',
      'standards.json',
      '--judge',
      'judge.jsonl',
      '--task',
      'task.jsonl',
      '--operational',
      'operational.jsonl',
    ]),
    {
      standards: 'standards.json',
      judge: 'judge.jsonl',
      task: 'task.jsonl',
      operational: 'operational.jsonl',
    },
  );
  assert.throws(() => parseArgs(['--judge', 'judge.jsonl']), /--standards is required/);
});
