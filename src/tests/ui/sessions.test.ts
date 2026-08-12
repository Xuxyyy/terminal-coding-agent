import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {projectDir} from '../../core/projects.js';
import type {SessionMeta} from '../../core/store.js';
import {startSession} from '../../core/store.js';
import {ageLabel, rowLine, sessionRow, sessionRows} from '../../ui/sessions.js';

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 2,
    id: '20260811-100400-a1b2c3d4',
    workspace: '/tmp/work',
    startedAt: '2026-08-11T10:04:00.000Z',
    updatedAt: '2026-08-11T11:20:00.000Z',
    status: 'closed',
    usage: {prompt: 11_450, completion: 1_000, total: 12_450},
    ...extra,
  };
}

const NOW = new Date('2026-08-11T11:21:00.000Z');

test('a row is titled by the first task', () => {
  const row = sessionRow(meta({firstTask: 'fix the cart total rounding bug'}), NOW);

  assert.equal(row.title, 'fix the cart total rounding bug');
  assert.equal(row.age, '1m');
  assert.equal(row.id, '20260811-100400-a1b2c3d4');
});

test('a session with no first task falls back to its id', () => {
  const row = sessionRow(meta(), NOW);

  assert.equal(row.title, '20260811-100400-a1b2c3d4');
});

test('the age counts from the last use, in one short unit', () => {
  const from = '2026-08-11T11:20:00.000Z';
  const at = (iso: string) => ageLabel(from, new Date(iso));

  assert.equal(at('2026-08-11T11:20:30.000Z'), 'now');
  assert.equal(at('2026-08-11T11:21:00.000Z'), '1m');
  assert.equal(at('2026-08-11T12:19:00.000Z'), '59m');
  assert.equal(at('2026-08-11T13:20:00.000Z'), '2h');
  assert.equal(at('2026-08-12T11:20:00.000Z'), '1d');
  assert.equal(at('2026-09-20T11:20:00.000Z'), '1mo');
  assert.equal(at('2027-09-20T11:20:00.000Z'), '1y');
});

test('a row pushes the age to the right edge', () => {
  const row = {id: 'x', title: 'fix the cart', age: '2h'};

  assert.equal(rowLine(row, true, 20), '❯ fix the cart    2h');
  assert.equal(rowLine(row, false, 20), '  fix the cart    2h');
});

test('a long title is cut so the age still fits', () => {
  const row = {id: 'x', title: 'a'.repeat(40), age: '12d'};

  const line = rowLine(row, true, 20);

  assert.equal(line.length, 20);
  assert.ok(line.endsWith('… 12d'));
});

test('the picker skips a version 1 session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-work-'));
  process.env.ACC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
  const live = startSession(root);
  live.appendTurn([{role: 'user', content: 'the new one'}], {
    prompt: 10,
    completion: 5,
    total: 15,
  });
  live.close();
  const old = path.join(projectDir(root), 'sessions', '20260810-090000-aaaabbbb');
  fs.mkdirSync(old, {recursive: true});
  fs.writeFileSync(
    path.join(old, 'session.json'),
    JSON.stringify(
      meta({version: 1, id: '20260810-090000-aaaabbbb', workspace: root}),
    ),
  );

  const rows = sessionRows(root);

  assert.deepEqual(
    rows.map((row) => row.title),
    ['the new one'],
  );
});

test('a session that never ran a turn is not offered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-work-'));
  process.env.ACC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
  const real = startSession(root);
  real.appendTurn([{role: 'user', content: 'fix the cart'}], {
    prompt: 10,
    completion: 5,
    total: 15,
  });
  real.close();
  startSession(root).close();

  const rows = sessionRows(root);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'fix the cart');
});
