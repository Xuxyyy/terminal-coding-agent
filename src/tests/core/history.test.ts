import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {captureBefore, filesDir, restorePlan} from '../../core/history.js';
import type {SessionRecord} from '../../core/records.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function session(): string {
  return tempDir('acc-session-');
}

function workspace(): string {
  return tempDir('acc-work-');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function copies(dir: string): string[] {
  return fs.existsSync(filesDir(dir)) ? fs.readdirSync(filesDir(dir)).sort() : [];
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function writtenAt(target: string): bigint {
  return fs.statSync(target, {bigint: true}).mtimeNs;
}

test('a captured file is stored under the sha256 of its bytes', () => {
  const dir = session();
  const work = workspace();
  const file = path.join(work, 'note.txt');
  fs.writeFileSync(file, 'one\n');

  const sha = captureBefore(dir, file);

  assert.equal(sha, sha256('one\n'));
  assert.deepEqual(copies(dir), [sha]);
  assert.equal(fs.readFileSync(path.join(filesDir(dir), sha!), 'utf8'), 'one\n');
});

test('a file that does not exist yet is captured as nothing at all', () => {
  const dir = session();
  const work = workspace();

  const sha = captureBefore(dir, path.join(work, 'new.txt'));

  assert.equal(sha, null);
  assert.equal(fs.existsSync(filesDir(dir)), false);
});

test('the same content twice is copied once', () => {
  const dir = session();
  const work = workspace();
  const first = path.join(work, 'a.txt');
  const second = path.join(work, 'b.txt');
  fs.writeFileSync(first, 'same\n');
  fs.writeFileSync(second, 'same\n');

  const one = captureBefore(dir, first);
  const written = writtenAt(path.join(filesDir(dir), one!));
  const two = captureBefore(dir, second);

  assert.equal(two, one);
  assert.deepEqual(copies(dir), [one]);
  assert.equal(writtenAt(path.join(filesDir(dir), one!)), written);
});

test('two different contents are two copies', () => {
  const dir = session();
  const work = workspace();
  const file = path.join(work, 'note.txt');
  fs.writeFileSync(file, 'one\n');
  const first = captureBefore(dir, file);
  fs.writeFileSync(file, 'two\n');
  const second = captureBefore(dir, file);

  assert.notEqual(first, second);
  assert.deepEqual(copies(dir), [first, second].sort());
  assert.equal(fs.readFileSync(path.join(filesDir(dir), first!), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(filesDir(dir), second!), 'utf8'), 'two\n');
});

test('a captured file is not readable by anyone else', () => {
  const dir = session();
  const work = workspace();
  const file = path.join(work, 'secret.txt');
  fs.writeFileSync(file, 'a password lives in here\n');

  const sha = captureBefore(dir, file);

  assert.equal(mode(filesDir(dir)), 0o700);
  assert.equal(mode(path.join(filesDir(dir), sha!)), 0o600);
});

test('capturing a folder is an error the caller sees', () => {
  const dir = session();
  const work = workspace();
  fs.mkdirSync(path.join(work, 'src'));

  assert.throws(() => captureBefore(dir, path.join(work, 'src')));
});

function code(target: string, before: string | null): SessionRecord {
  return {kind: 'code', path: target, before};
}

const TASK: SessionRecord = {
  kind: 'message',
  id: 'one',
  message: {role: 'user', content: 'fix the cart'},
};

test('two edits to one file restore what the first one found', () => {
  const plan = restorePlan(
    [code('cart.ts', sha256('one\n')), code('cart.ts', sha256('two\n'))],
    0,
  );

  assert.deepEqual([...plan], [['cart.ts', sha256('one\n')]]);
});

test('a file written below the cut is left alone', () => {
  const plan = restorePlan([code('early.ts', sha256('one\n')), TASK, code('late.ts', null)], 1);

  assert.deepEqual([...plan.keys()], ['late.ts']);
});

test('two paths above the cut are two entries', () => {
  const plan = restorePlan([code('cart.ts', sha256('one\n')), code('total.ts', null)], 0);

  assert.equal(plan.size, 2);
  assert.equal(plan.get('cart.ts'), sha256('one\n'));
  assert.equal(plan.get('total.ts'), null);
});

test('a file that did not exist yet is planned as null, not as missing', () => {
  const plan = restorePlan([code('new.txt', null), code('new.txt', sha256('one\n'))], 0);

  assert.equal(plan.has('new.txt'), true);
  assert.equal(plan.get('new.txt'), null);
});

test('a rewind over no edits at all restores nothing', () => {
  assert.equal(restorePlan([TASK, {kind: 'view', items: []}], 0).size, 0);
});

test('the records between the edits change nothing', () => {
  const plan = restorePlan(
    [
      code('cart.ts', sha256('one\n')),
      {kind: 'view', items: [{kind: 'text', text: 'done'}]},
      {kind: 'compact', summary: 'a summary', replaced: 4},
      TASK,
      code('cart.ts', sha256('two\n')),
    ],
    0,
  );

  assert.deepEqual([...plan], [['cart.ts', sha256('one\n')]]);
});
