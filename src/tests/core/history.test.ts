import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {captureBefore, filesDir} from '../../core/history.js';

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
