import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {SessionMeta} from '../../core/store.js';
import {startSession} from '../../core/store.js';
import {sessionRow, sessionRows} from '../../ui/sessions.js';

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 1,
    id: '20260811-100400-a1b2c3d4',
    workspace: '/tmp/work',
    startedAt: '2026-08-11T10:04:00.000Z',
    updatedAt: '2026-08-11T11:20:00.000Z',
    status: 'closed',
    usage: {prompt: 11_450, completion: 1_000, total: 12_450},
    ...extra,
  };
}

test('a row is titled by the first task', () => {
  const row = sessionRow(meta({firstTask: 'fix the cart total rounding bug'}));

  assert.equal(row.title, 'fix the cart total rounding bug');
  assert.equal(row.detail, '2026-08-11 10:04 · 12,450 tokens');
  assert.equal(row.id, '20260811-100400-a1b2c3d4');
});

test('a session with no first task falls back to its id', () => {
  const row = sessionRow(meta());

  assert.equal(row.title, '20260811-100400-a1b2c3d4');
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
