import assert from 'node:assert/strict';
import test from 'node:test';
import {formatReport, median, score, type Outcome} from './score.js';

type Fields = Partial<Outcome> & {
  steps?: number;
  toolErrors?: number;
  tokens?: number;
};

function outcome({steps = 1, toolErrors = 0, tokens = 100, ...overrides}: Fields = {}): Outcome {
  return {
    id: 'case-1',
    category: 'edit',
    result: 'pass',
    solved: true,
    clean: true,
    stopped: 'done',
    metrics: {steps, toolCalls: steps, toolErrors, tokens, prompts: 0},
    checks: [],
    changes: {added: [], modified: [], deleted: []},
    outside: [],
    ...overrides,
  };
}

test('a run where every trial passed reports both rates at one and no errors', () => {
  const report = score(
    [outcome({id: 'a'}), outcome({id: 'b'}), outcome({id: 'c'})],
    1,
  );

  assert.deepEqual(report.solved, {count: 3, of: 3, rate: 1});
  assert.deepEqual(report.clean, {count: 3, of: 3, rate: 1});
  assert.deepEqual(report.passHatK, {count: 3, of: 3, rate: 1});
  assert.equal(report.errors, 0);
});

test('a solved but unclean trial raises solved and not clean', () => {
  const report = score(
    [
      outcome({id: 'tidy', solved: true, clean: true}),
      outcome({id: 'messy', solved: true, clean: false}),
    ],
    1,
  );

  assert.deepEqual(report.solved, {count: 2, of: 2, rate: 1});
  assert.deepEqual(report.clean, {count: 1, of: 2, rate: 0.5});
});

test('errors are excluded from both rates and counted on their own', () => {
  const report = score(
    [
      outcome({id: 'a', result: 'pass'}),
      outcome({id: 'b', result: 'fail', solved: false}),
      outcome({
        id: 'c',
        result: 'error',
        solved: false,
        clean: false,
        stopped: 'error',
        error: 'timed out',
      }),
    ],
    1,
  );

  assert.equal(report.total, 3);
  assert.equal(report.scored, 2);
  assert.equal(report.errors, 1);
  assert.deepEqual(report.solved, {count: 1, of: 2, rate: 0.5});
  assert.deepEqual(report.clean, {count: 2, of: 2, rate: 1});
});

test('one failure among three trials drops the case out of pass hat k entirely', () => {
  const results: Outcome['result'][] = ['pass', 'pass', 'fail'];

  const report = score(
    results.map((result) =>
      outcome({id: 'flaky', result, solved: result === 'pass'}),
    ),
    3,
  );

  assert.deepEqual(report.passHatK, {count: 0, of: 1, rate: 0});
  assert.equal(report.byCase[0]!.passes, 2);
});

test('a case whose every trial errored leaves the pass hat k denominator', () => {
  const report = score(
    [
      outcome({id: 'steady'}),
      outcome({id: 'steady'}),
      outcome({id: 'broken', result: 'error', stopped: 'error', error: 'no reply'}),
      outcome({id: 'broken', result: 'error', stopped: 'error', error: 'no reply'}),
    ],
    2,
  );

  assert.deepEqual(report.passHatK, {count: 1, of: 1, rate: 1});
});

test('median takes the middle of an odd list, the mean of the middle two of an even one, and null of nothing', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('a case carries the medians of its own non-error trials', () => {
  const report = score(
    [
      outcome({id: 'alpha', steps: 4, toolErrors: 1, tokens: 100}),
      outcome({id: 'alpha', steps: 8, toolErrors: 3, tokens: 300}),
      outcome({
        id: 'alpha',
        result: 'error',
        stopped: 'error',
        error: 'no reply',
        steps: 900,
        toolErrors: 900,
        tokens: 900,
      }),
      outcome({id: 'beta', category: 'find', steps: 2, toolErrors: 0, tokens: 50}),
    ],
    3,
  );

  assert.deepEqual(report.byCase, [
    {
      id: 'alpha',
      category: 'edit',
      total: 3,
      errors: 1,
      passes: 2,
      steps: 6,
      toolErrors: 2,
      tokens: 200,
    },
    {
      id: 'beta',
      category: 'find',
      total: 1,
      errors: 0,
      passes: 1,
      steps: 2,
      toolErrors: 0,
      tokens: 50,
    },
  ]);
});

test('byCategory holds a row only for a category that appears, counted over non-error trials', () => {
  const report = score(
    [
      outcome({id: 'e1', category: 'edit'}),
      outcome({id: 'f1', category: 'find', result: 'fail', solved: false, clean: false}),
      outcome({
        id: 'f2',
        category: 'find',
        result: 'error',
        solved: false,
        clean: false,
        stopped: 'error',
        error: 'timed out',
      }),
    ],
    1,
  );

  assert.deepEqual(report.byCategory, [
    {category: 'edit', total: 1, errors: 0, scored: 1, solved: 1, clean: 1},
    {category: 'find', total: 2, errors: 1, scored: 1, solved: 0, clean: 0},
  ]);
});

test('unstable names the case whose repeats disagreed and stays empty when they all agreed', () => {
  const repeats = (id: string, results: Outcome['result'][]): Outcome[] =>
    results.map((result) => outcome({id, result, solved: result === 'pass'}));

  assert.deepEqual(
    score([...repeats('flaky', ['pass', 'fail']), ...repeats('steady', ['pass', 'pass'])], 2)
      .unstable,
    ['flaky'],
  );
  assert.deepEqual(score(repeats('steady', ['fail', 'fail']), 2).unstable, []);
});

test('the report text keeps solved, clean and pass hat k on three lines and names every case', () => {
  const report = score(
    [
      outcome({id: 'alpha'}),
      outcome({id: 'alpha', result: 'fail', solved: false}),
      outcome({id: 'beta', category: 'find', clean: false}),
      outcome({
        id: 'beta',
        category: 'find',
        result: 'error',
        stopped: 'error',
        error: 'timed out',
      }),
    ],
    3,
  );

  const text = formatReport(report);
  const lines = text.split('\n');

  assert.equal(text.includes('4 trials, 3 scored, 1 excluded as errors'), true);
  assert.equal(lines.filter((line) => line.startsWith('solved')).length, 1);
  assert.equal(lines.filter((line) => line.startsWith('clean')).length, 1);
  assert.equal(lines.filter((line) => line.startsWith('pass^3')).length, 1);
  for (const entry of report.byCase) {
    assert.equal(text.includes(entry.id), true);
  }
  for (const entry of report.byCategory) {
    assert.equal(text.includes(entry.category), true);
  }
  assert.equal(text.includes('case'), true);
  assert.equal(text.includes('tool-err'), true);
});

test('the report text names the repeats it was scored with', () => {
  const text = formatReport(score([outcome({id: 'alpha'})], 5));

  assert.equal(text.includes('pass^5'), true);
  assert.equal(text.includes('pass^3'), false);
});
