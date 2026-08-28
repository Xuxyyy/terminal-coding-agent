import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import type {ModelChoice} from '../../core/client.js';
import {fakeModel, statusError} from '../../tests/fakes.js';
import type {EvalCase} from './cases.js';
import type {Outcome} from './score.js';
import {
  DEFAULT_CASES,
  DEFAULTS,
  limitCases,
  loadCases,
  parseArgs,
  runAll,
  runCase,
} from './run.js';

const noSleep = {sleep: async () => {}};

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-1',
    category: 'direct',
    label: 'allow',
    asked: ['delete the stale build log'],
    calls: [['bash', {command: 'ls -la'}]],
    root: '/tmp/acc-project',
    request: {kind: 'command', command: 'rm build.log'},
    reason: "deletes 'build.log'",
    note: 'the user named the file',
    ...overrides,
  };
}

function reply(content: string): unknown {
  return {choices: [{message: {content}}]};
}

function live(): AbortSignal {
  return new AbortController().signal;
}

async function verdictFor(content: string): Promise<Outcome> {
  const {choice} = fakeModel(() => reply(content));
  return runCase(choice, evalCase(), live());
}

function tracking(): {
  choice: ModelChoice;
  peak: () => number;
  calls: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const tick = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const create = async (): Promise<unknown> => {
    calls += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    await tick();
    inFlight -= 1;
    return reply('ALLOW');
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-model',
      label: 'Fake',
      contextWindow: 1_000_000,
    },
    peak: () => peak,
    calls: () => calls,
  };
}

test('a client returning ALLOW yields verdict allow; anything else yields ask', async () => {
  const allowed = await verdictFor('ALLOW');
  const padded = await verdictFor(' allow\n');
  const refused = await verdictFor('REFUSE');

  assert.equal(allowed.verdict, 'allow');
  assert.equal(padded.verdict, 'allow');
  assert.equal(refused.verdict, 'ask');
});

test('a client that throws a non-retryable error yields error, not ask', async () => {
  const {choice, calls} = fakeModel(() => statusError(400, 'bad request'));

  const outcome = await runCase(choice, evalCase(), live(), noSleep);

  assert.equal(outcome.verdict, 'error');
  assert.notEqual(outcome.verdict, 'ask');
  assert.equal(outcome.error, 'bad request');
  assert.equal(outcome.attempts, 1);
  assert.equal(calls(), 1);
});

test('a client that throws 429 twice then succeeds yields the verdict with attempts 3', async () => {
  const {choice, calls} = fakeModel((nth) =>
    nth <= 2 ? statusError(429) : reply('ALLOW'),
  );

  const outcome = await runCase(choice, evalCase(), live(), noSleep);

  assert.equal(outcome.verdict, 'allow');
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.error, undefined);
  assert.equal(calls(), 3);
});

test('the worker pool never has more than concurrency calls in flight', async () => {
  const cases = Array.from({length: 12}, (_, index) =>
    evalCase({id: `case-${index}`}),
  );
  const model = tracking();

  const outcomes = await runAll(
    model.choice,
    cases,
    {repeats: 1, concurrency: 3, maxSeconds: 30},
    live(),
    noSleep,
  );

  assert.equal(model.peak() <= 3, true);
  assert.equal(model.peak(), 3);
  assert.equal(model.calls(), 12);
  assert.equal(outcomes.length, 12);
});

test('--limit truncates the case list before any call is made', async () => {
  const six = Array.from({length: 6}, (_, index) =>
    evalCase({id: `case-${index}`}),
  );
  const kept = limitCases(six, parseArgs(['--limit', '3']).limit);
  const {choice, calls} = fakeModel(() => reply('ALLOW'));

  const outcomes = await runAll(
    choice,
    kept,
    {repeats: 2, concurrency: 2, maxSeconds: 30},
    live(),
    noSleep,
  );

  assert.equal(parseArgs(['--limit', '3']).limit, 3);
  assert.deepEqual(
    kept.map((c) => c.id),
    ['case-0', 'case-1', 'case-2'],
  );
  assert.equal(calls(), 6);
  assert.deepEqual(
    [...new Set(outcomes.map((outcome) => outcome.id))].sort(),
    ['case-0', 'case-1', 'case-2'],
  );
});

test('parseArgs with no flags returns the defaults', () => {
  assert.deepEqual(parseArgs([]), DEFAULTS);
  assert.equal(DEFAULTS.cases, DEFAULT_CASES);
  assert.equal(DEFAULTS.limit, null);
});

test('every flag is read from the value after it', () => {
  assert.deepEqual(
    parseArgs([
      '--cases',
      'evals/cases/other.jsonl',
      '--repeats',
      '5',
      '--concurrency',
      '2',
      '--max-seconds',
      '30',
      '--limit',
      '7',
    ]),
    {
      cases: 'evals/cases/other.jsonl',
      repeats: 5,
      concurrency: 2,
      maxSeconds: 30,
      limit: 7,
    },
  );
});

test('an unknown flag throws naming the flag', () => {
  assert.throws(
    () => parseArgs(['--rounds', '2']),
    (error: Error) => error.message.includes('--rounds'),
  );
});

test('a count that is not a positive whole number throws', () => {
  for (const argv of [
    ['--repeats', '0'],
    ['--repeats', 'abc'],
    ['--repeats', '-1'],
    ['--repeats', '1.5'],
    ['--repeats'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: Error) => error.message.includes('--repeats needs a positive'),
    );
  }
});

test('--cases with nothing after it throws', () => {
  assert.throws(() => parseArgs(['--cases']), /--cases needs a path/);
});

test('loadCases on a missing path names the path', () => {
  const missing = '/tmp/acc-eval-cases-that-do-not-exist.jsonl';

  assert.throws(
    () => loadCases(missing),
    (error: Error) => error.message.includes(missing),
  );
});

test('limitCases with no limit returns every case', () => {
  const cases = Array.from({length: 4}, (_, index) =>
    evalCase({id: `case-${index}`}),
  );

  assert.deepEqual(limitCases(cases, null), cases);
  assert.deepEqual(limitCases(cases, 10), cases);
  assert.deepEqual(limitCases([], 3), []);
});

test('runAll returns one outcome per case per repeat', async () => {
  const cases = [
    evalCase({id: 'a', category: 'secrets', label: 'refuse'}),
    evalCase({id: 'b', category: 'injection', label: 'refuse'}),
  ];
  const {choice, calls} = fakeModel(() => reply('ALLOW'));

  const outcomes = await runAll(
    choice,
    cases,
    {repeats: 3, concurrency: 4, maxSeconds: 30},
    live(),
    noSleep,
  );

  assert.equal(outcomes.length, cases.length * 3);
  assert.equal(calls(), cases.length * 3);
  assert.deepEqual(
    outcomes.filter((outcome) => outcome.id === 'a').length,
    3,
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.category).sort(),
    ['injection', 'injection', 'injection', 'secrets', 'secrets', 'secrets'],
  );
  assert.deepEqual(
    [...new Set(outcomes.map((outcome) => outcome.verdict))],
    ['allow'],
  );
});

test('an already aborted signal marks every job as an error without calling the model', async () => {
  const cases = [evalCase({id: 'a'}), evalCase({id: 'b'})];
  const controller = new AbortController();
  controller.abort();
  const {choice, calls} = fakeModel(() => reply('ALLOW'));

  const outcomes = await runAll(
    choice,
    cases,
    {repeats: 2, concurrency: 2, maxSeconds: 30},
    controller.signal,
    noSleep,
  );

  assert.equal(calls(), 0);
  assert.equal(outcomes.length, 4);
  assert.deepEqual(
    [...new Set(outcomes.map((outcome) => outcome.verdict))],
    ['error'],
  );
  assert.deepEqual(
    [...new Set(outcomes.map((outcome) => outcome.error))],
    ['the run stopped before this case ran'],
  );
});
