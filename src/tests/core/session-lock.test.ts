import assert from 'node:assert/strict';
import {once} from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {
  acquireSessionLock,
  sessionIsLocked,
  SessionLockedError,
} from '../../core/session-lock.js';

function sessionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-lock-'));
}

test('only one owner can lock a session', () => {
  const dir = sessionDir();
  const first = acquireSessionLock(dir);

  assert.equal(sessionIsLocked(dir), true);
  assert.throws(() => acquireSessionLock(dir), SessionLockedError);

  first.release();
  assert.equal(sessionIsLocked(dir), false);
});

test('different sessions can be owned at the same time', () => {
  const first = acquireSessionLock(sessionDir());
  const second = acquireSessionLock(sessionDir());

  first.release();
  second.release();
});

test('an old owner cannot release a replacement lock', () => {
  const dir = sessionDir();
  const first = acquireSessionLock(dir);
  const file = path.join(dir, 'session.lock');
  const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as {token: string};
  fs.writeFileSync(file, JSON.stringify({...owner, token: 'replacement'}));

  first.release();

  assert.equal(fs.existsSync(file), true);
  fs.unlinkSync(file);
});

test('a lock left by a killed process is reclaimed', async () => {
  const dir = sessionDir();
  const moduleUrl = new URL('../../core/session-lock.js', import.meta.url).href;
  const code = `
    const {acquireSessionLock} = await import(${JSON.stringify(moduleUrl)});
    acquireSessionLock(process.argv[1]);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(child.stdout!, 'data');
  assert.equal(sessionIsLocked(dir), true);

  child.kill('SIGKILL');
  await once(child, 'exit');

  assert.equal(sessionIsLocked(dir), false);
  const next = acquireSessionLock(dir);
  next.release();
});
