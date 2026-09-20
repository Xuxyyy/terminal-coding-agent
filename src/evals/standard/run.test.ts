import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  checkEvidence,
  loadEvidence,
  loadStandards,
  parseArgs,
  type Evidence,
  type StandardReport,
  type Standards,
} from './run.js';

const standards: Standards = {
  version: 2,
  model: 'test-model',
  judge: {repeats: 3, caseIds: ['judge-1'], maxFalseAllows: 0},
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

function validEvidence(): [Evidence, Evidence] {
  return [judgeEvidence(), operationalEvidence()];
}

function status(report: StandardReport, name: string): 'pass' | 'fail' {
  const found = report.axes.find((entry) => entry.axis === name);
  assert.ok(found, `missing axis ${name}`);
  return found.status;
}

test('a complete matching evidence set passes every independent axis', () => {
  const report = checkEvidence(standards, ...validEvidence());

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.axes.map((entry) => entry.axis),
    [
      'judge.metadata',
      'judge.harness',
      'judge.false-allow',
      'operational.metadata',
      'operational.scenarios',
    ],
  );
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

test('standards version 2 has judge and operational gates only', () => {
  const root = mkdtempSync(join(tmpdir(), 'acc-standard-test-'));
  try {
    const path = join(root, 'standards.json');
    writeFileSync(path, JSON.stringify(standards));
    assert.deepEqual(loadStandards(path), standards);

    writeFileSync(path, JSON.stringify({...standards, version: 1}));
    assert.throws(() => loadStandards(path), /unsupported standards version 1/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('model mismatch fails judge metadata', () => {
  const [judge, operational] = validEvidence();
  (judge.report.metadata as Record<string, unknown>).requestedModel = {id: 'other'};

  assert.equal(status(checkEvidence(standards, judge, operational), 'judge.metadata'), 'fail');
});

test('case-set mismatch fails judge metadata even when totals still match', () => {
  const [judge, operational] = validEvidence();
  judge.records[0]!.id = 'unexpected';

  assert.equal(status(checkEvidence(standards, judge, operational), 'judge.metadata'), 'fail');
});

test('judge harness errors fail their own axis', () => {
  const [judge, operational] = validEvidence();
  judge.report.errors = 1;
  judge.records[0]!.verdict = 'error';

  assert.equal(status(checkEvidence(standards, judge, operational), 'judge.harness'), 'fail');
});

test('any false allow fails the safety axis', () => {
  const [judge, operational] = validEvidence();
  judge.report.falseAllow = {count: 1, of: 3, rate: 1 / 3};

  assert.equal(status(checkEvidence(standards, judge, operational), 'judge.false-allow'), 'fail');
});

test('an operational failure fails without hiding the judge axis', () => {
  const [judge, operational] = validEvidence();
  operational.records[0]!.status = 'fail';
  operational.report.failures = 1;
  const report = checkEvidence(standards, judge, operational);

  assert.equal(status(report, 'operational.scenarios'), 'fail');
  assert.equal(status(report, 'judge.false-allow'), 'pass');
});

test('all three evidence paths are explicit and required', () => {
  assert.deepEqual(
    parseArgs([
      '--standards',
      'standards.json',
      '--judge',
      'judge.jsonl',
      '--operational',
      'operational.jsonl',
    ]),
    {
      standards: 'standards.json',
      judge: 'judge.jsonl',
      operational: 'operational.jsonl',
    },
  );
  assert.throws(() => parseArgs(['--judge', 'judge.jsonl']), /--standards is required/);
  assert.throws(
    () => parseArgs(['--task', 'task.jsonl']),
    /unknown flag '--task'/,
  );
});
