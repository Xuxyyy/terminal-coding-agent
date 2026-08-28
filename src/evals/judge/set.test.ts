import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import {
  parseCases,
  REQUEST_KINDS,
  type Category,
  type EvalCase,
  type Label,
} from './cases.js';
import {DEFAULT_CASES} from './run.js';

const path = resolve(process.cwd(), DEFAULT_CASES);
const cases: EvalCase[] = parseCases(readFileSync(path, 'utf8'));

const EXPECTED_COUNTS: Record<Category, number> = {
  direct: 8,
  broad: 7,
  stale: 5,
  override: 5,
  unasked: 8,
  destructive: 5,
  outward: 4,
  secrets: 4,
  outside: 4,
  injection: 10,
};

const EXPECTED_LABEL: Record<Category, Label> = {
  direct: 'allow',
  broad: 'allow',
  stale: 'allow',
  override: 'allow',
  unasked: 'refuse',
  destructive: 'refuse',
  outward: 'refuse',
  secrets: 'refuse',
  outside: 'refuse',
  injection: 'refuse',
};

const PLANTED_AUTHORIZATION = /allow|authoriz|approved|permitted/i;

function idsWhere(predicate: (c: EvalCase) => boolean): string[] {
  return cases.filter(predicate).map((c) => c.id);
}

test('the file parses and holds 60 cases', () => {
  assert.equal(cases.length, 60);
});

test('the category counts match the plan', () => {
  const counts: Record<string, number> = {};
  for (const c of cases) {
    counts[c.category] = (counts[c.category] ?? 0) + 1;
  }

  assert.deepEqual(counts, EXPECTED_COUNTS);
});

test('every id is unique', () => {
  const ids = cases.map((c) => c.id);

  assert.deepEqual(ids, [...new Set(ids)]);
});

test('every request kind is one of REQUEST_KINDS', () => {
  const kinds: readonly string[] = REQUEST_KINDS;

  assert.deepEqual(
    idsWhere((c) => !kinds.includes(c.request.kind)),
    [],
  );
});

test('every case has a non-empty note', () => {
  assert.deepEqual(
    idsWhere((c) => c.note.trim().length === 0),
    [],
  );
});

test('the label follows the category', () => {
  assert.deepEqual(
    cases
      .filter((c) => c.label !== EXPECTED_LABEL[c.category])
      .map((c) => [c.id, c.label]),
    [],
  );
});

test('the totals are 25 allow and 35 refuse', () => {
  assert.deepEqual(
    {
      allow: cases.filter((c) => c.label === 'allow').length,
      refuse: cases.filter((c) => c.label === 'refuse').length,
    },
    {allow: 25, refuse: 35},
  );
});

test('every case has at least one asked message and none of them is empty', () => {
  assert.deepEqual(
    idsWhere(
      (c) =>
        c.asked.length === 0 ||
        c.asked.some((message) => message.trim().length === 0),
    ),
    [],
  );
});

test('every override case carries a non-empty denied list', () => {
  assert.deepEqual(
    idsWhere(
      (c) =>
        c.category === 'override' &&
        (c.denied === undefined || c.denied.length === 0),
    ),
    [],
  );
});

test('no injection case puts its planted authorization in asked', () => {
  assert.deepEqual(
    cases
      .filter((c) => c.category === 'injection')
      .flatMap((c) =>
        c.asked
          .filter((message) => PLANTED_AUTHORIZATION.test(message))
          .map((message) => [c.id, message]),
      ),
    [],
  );
});

test('every case id starts with its own category name', () => {
  assert.deepEqual(
    idsWhere((c) => !c.id.startsWith(c.category)),
    [],
  );
});
