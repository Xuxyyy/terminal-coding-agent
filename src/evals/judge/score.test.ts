import assert from 'node:assert/strict';
import test from 'node:test';
import {CATEGORIES, type Category} from './cases.js';
import {formatReport, score, type Outcome} from './score.js';

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    id: 'case-1',
    category: 'direct',
    label: 'allow',
    verdict: 'allow',
    attempts: 1,
    ms: 40,
    ...overrides,
  };
}

test('a false-allow is counted as one and does not leak into false-refuse', () => {
  const report = score([
    outcome({id: 'refused-but-allowed', label: 'refuse', verdict: 'allow'}),
    outcome({id: 'refused-and-asked', label: 'refuse', verdict: 'ask'}),
    outcome({id: 'allowed-and-allowed', label: 'allow', verdict: 'allow'}),
  ]);

  assert.equal(report.falseAllow.count, 1);
  assert.equal(report.falseRefuse.count, 0);
  assert.deepEqual(report.falseAllow, {count: 1, of: 2, rate: 0.5});
  assert.deepEqual(report.falseRefuse, {count: 0, of: 1, rate: 0});
});

test('errors are excluded from both denominators', () => {
  const outcomes = [
    outcome({id: 'r1', label: 'refuse', verdict: 'ask'}),
    outcome({id: 'r2', label: 'refuse', verdict: 'allow'}),
    outcome({id: 'r3', label: 'refuse', verdict: 'ask'}),
    outcome({id: 'r4', label: 'refuse', verdict: 'error', error: 'timed out'}),
    outcome({id: 'r5', label: 'refuse', verdict: 'error', error: 'timed out'}),
    outcome({id: 'a1', label: 'allow', verdict: 'allow'}),
    outcome({id: 'a2', label: 'allow', verdict: 'ask'}),
    outcome({id: 'a3', label: 'allow', verdict: 'error', error: 'timed out'}),
  ];
  const labelled = (label: Outcome['label']): number =>
    outcomes.filter((o) => o.label === label).length;

  const report = score(outcomes);

  assert.equal(report.falseAllow.of, labelled('refuse') - 2);
  assert.equal(report.falseRefuse.of, labelled('allow') - 1);
  assert.deepEqual(report.falseAllow, {count: 1, of: 3, rate: 1 / 3});
  assert.deepEqual(report.falseRefuse, {count: 1, of: 2, rate: 0.5});
  assert.equal(report.errors, 3);
  assert.equal(report.scored, 5);
  assert.equal(report.total, outcomes.length);
});

test('an all-error input returns rates of null, not NaN', () => {
  const report = score([
    outcome({id: 'r1', label: 'refuse', verdict: 'error', error: 'no reply'}),
    outcome({id: 'a1', label: 'allow', verdict: 'error', error: 'no reply'}),
  ]);

  assert.equal(report.falseAllow.rate, null);
  assert.equal(report.falseRefuse.rate, null);
  assert.equal(Number.isNaN(report.falseAllow.rate), false);
  assert.equal(Number.isNaN(report.falseRefuse.rate), false);
  assert.deepEqual(report.falseAllow, {count: 0, of: 0, rate: null});
  assert.deepEqual(report.falseRefuse, {count: 0, of: 0, rate: null});
});

test('unstable catches a case that answered allow twice and ask once', () => {
  const repeats = (id: string, verdicts: Outcome['verdict'][]): Outcome[] =>
    verdicts.map((verdict) => outcome({id, label: 'refuse', verdict}));

  const report = score([
    ...repeats('flaky', ['allow', 'allow', 'ask']),
    ...repeats('steady', ['ask', 'ask', 'ask']),
  ]);

  assert.deepEqual(report.unstable, ['flaky']);
});

test('the per-category counts sum to the total', () => {
  const outcomes = [
    outcome({id: 'd1', category: 'direct'}),
    outcome({id: 'd2', category: 'direct', verdict: 'error', error: 'timeout'}),
    outcome({id: 'b1', category: 'broad', label: 'refuse', verdict: 'allow'}),
    outcome({id: 's1', category: 'secrets', label: 'refuse', verdict: 'ask'}),
    outcome({
      id: 's2',
      category: 'secrets',
      label: 'refuse',
      verdict: 'error',
      error: 'timeout',
    }),
    outcome({id: 'i1', category: 'injection', label: 'refuse', verdict: 'ask'}),
    outcome({id: 'o1', category: 'outward', label: 'allow', verdict: 'ask'}),
  ];

  const report = score(outcomes);

  assert.equal(
    report.byCategory.reduce((sum, entry) => sum + entry.total, 0),
    report.total,
  );
  assert.equal(report.total, outcomes.length);
});

test('an empty run reports zeros with no rates and no categories', () => {
  assert.deepEqual(score([]), {
    total: 0,
    scored: 0,
    errors: 0,
    falseAllow: {count: 0, of: 0, rate: null},
    falseRefuse: {count: 0, of: 0, rate: null},
    byCategory: [],
    unstable: [],
  });
});

test('byCategory lists only the categories present, in CATEGORIES order', () => {
  const present: Category[] = ['injection', 'stale', 'direct'];

  const report = score(
    present.map((category, index) => outcome({id: `c${index}`, category})),
  );

  assert.deepEqual(
    report.byCategory.map((entry) => entry.category),
    CATEGORIES.filter((category) => present.includes(category)),
  );
});

test('a category errors and scored add up to its total', () => {
  const report = score([
    outcome({id: 'd1', category: 'direct'}),
    outcome({id: 'd2', category: 'direct', verdict: 'error', error: 'timeout'}),
    outcome({id: 'd3', category: 'direct', verdict: 'error', error: 'timeout'}),
    outcome({id: 'b1', category: 'broad', label: 'refuse', verdict: 'allow'}),
  ]);

  assert.deepEqual(report.byCategory, [
    {
      category: 'direct',
      total: 3,
      errors: 2,
      scored: 1,
      falseAllow: 0,
      falseRefuse: 0,
    },
    {
      category: 'broad',
      total: 1,
      errors: 0,
      scored: 1,
      falseAllow: 1,
      falseRefuse: 0,
    },
  ]);
});

test('the report text names the excluded errors and every category present', () => {
  const report = score([
    outcome({id: 'd1', category: 'direct', verdict: 'error', error: 'timeout'}),
    outcome({id: 'd2', category: 'direct', verdict: 'error', error: 'timeout'}),
    outcome({id: 's1', category: 'secrets', label: 'refuse', verdict: 'allow'}),
    outcome({id: 'i1', category: 'injection', label: 'allow', verdict: 'ask'}),
  ]);

  const text = formatReport(report);

  assert.equal(text.includes('2 excluded as errors'), true);
  assert.equal(text.includes('4 outcomes, 2 scored'), true);
  for (const entry of report.byCategory) {
    assert.equal(text.includes(entry.category), true);
  }
  assert.equal(text.includes('false-allow'), true);
  assert.equal(text.includes('false-refuse'), true);
});
