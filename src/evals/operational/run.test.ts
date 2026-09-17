import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  SCENARIO_IDS,
  formatReport,
  isolatedEnv,
  reportOf,
  runCommand,
  scenarioResult,
  withScratch,
} from './run.js';

const env = {...process.env};

test('runCommand captures a successful subprocess', () => {
  const result = runCommand(
    process.execPath,
    ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
    {cwd: process.cwd(), env},
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
});

test('runCommand preserves a nonzero status without calling it an error', () => {
  const result = runCommand(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: process.cwd(),
    env,
  });

  assert.equal(result.status, 7);
  assert.equal(result.error, undefined);
  assert.equal(result.timedOut, false);
});

test('runCommand reports a timeout separately from an ordinary failure', () => {
  const result = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(),
    env,
    timeout: 25,
  });

  assert.equal(result.timedOut, true);
  assert.match(result.error ?? '', /timed out|ETIMEDOUT/i);
});

test('runCommand reports a missing executable', () => {
  const result = runCommand('acc-no-such-operational-command', [], {
    cwd: process.cwd(),
    env,
  });

  assert.equal(result.status, null);
  assert.match(result.error ?? '', /ENOENT|not found/i);
});

test('isolatedEnv keeps ordinary values and masks every provider key', () => {
  const result = isolatedEnv('/tmp/acc-operational-home', {
    PATH: '/bin',
    DEEPSEEK_API_KEY: 'secret-one',
    GLM_API_KEY: 'secret-two',
    MOONSHOT_API_KEY: 'secret-three',
  });

  assert.equal(result.PATH, '/bin');
  assert.equal(result.ACC_HOME, '/tmp/acc-operational-home');
  assert.equal(result.DEEPSEEK_API_KEY, '');
  assert.equal(result.GLM_API_KEY, '');
  assert.equal(result.MOONSHOT_API_KEY, '');
});

test('scenarioResult distinguishes assertion failure from command error', () => {
  const failed = scenarioResult('installed-binary', Date.now(), () => ({
    ok: false,
    detail: 'wrong output',
    commands: [],
  }));
  const errored = scenarioResult('installed-binary', Date.now(), () => ({
    ok: false,
    detail: 'could not launch',
    commands: [
      {
        command: 'missing',
        status: null,
        signal: null,
        timedOut: false,
        durationMs: 1,
        stdout: '',
        stderr: '',
        error: 'ENOENT',
      },
    ],
  }));

  assert.equal(failed.status, 'fail');
  assert.equal(errored.status, 'error');
});

test('withScratch removes its directory after success and failure', () => {
  let successful = '';
  withScratch((root) => {
    successful = root;
    assert.equal(existsSync(root), true);
  });
  assert.equal(existsSync(successful), false);

  let failed = '';
  assert.throws(
    () =>
      withScratch((root) => {
        failed = root;
        throw new Error('stop');
      }),
    /stop/,
  );
  assert.equal(existsSync(failed), false);
});

test('the report keeps every axis and formats each scenario separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'acc-operational-report-'));
  try {
    const results = SCENARIO_IDS.map((id, index) => ({
      kind: 'scenario' as const,
      id,
      status: index === 0 ? ('fail' as const) : ('pass' as const),
      durationMs: index,
      detail: 'evidence',
      commands: [],
    }));
    const report = reportOf(
      results,
      new Date('2026-09-17T12:00:00.000Z'),
      42,
      root,
    );
    const formatted = formatReport(report);

    assert.equal(report.total, 6);
    assert.equal(report.passes, 5);
    assert.equal(report.failures, 1);
    assert.equal(report.errors, 0);
    assert.equal(report.metadata.scenarioCount, 6);
    for (const id of SCENARIO_IDS) assert.match(formatted, new RegExp(id));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
