import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {render} from 'ink';
import {SessionPicker} from '../../ui/components/SessionPicker.js';
import type {SessionRow} from '../../ui/sessions.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');
const ENTER = '\r';
const DOWN = `${ESC}[B`;

function fakeStdin(): {stdin: NodeJS.ReadStream; press: (key: string) => void} {
  const queue: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => queue.shift() ?? null,
    ref: () => stdin,
    unref: () => stdin,
  });
  return {
    stdin,
    press(key: string) {
      queue.push(key);
      stdin.emit('readable');
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

test('a locked session is labeled and cannot be opened', async () => {
  const rows: SessionRow[] = [
    {id: 'locked', title: 'fix the cart', age: '2h', locked: true},
    {id: 'free', title: 'add logs', age: '1d', locked: false},
  ];
  const picked: string[] = [];
  const frames: string[] = [];
  const stdout = {
    columns: 80,
    rows: 40,
    isTTY: true,
    write(chunk: string) {
      frames.push(chunk.replace(ANSI, ''));
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const {stdin, press} = fakeStdin();
  const instance = render(
    <SessionPicker rows={rows} onPick={(id) => picked.push(id)} onCancel={() => {}} />,
    {stdin, stdout, patchConsole: false, exitOnCtrlC: false},
  );

  await tick();
  press(ENTER);
  await tick();
  assert.deepEqual(picked, []);
  const lockedScreen =
    frames.filter((frame) => frame.includes('Reopen a conversation')).pop() ?? '';
  assert.ok(lockedScreen.includes('active elsewhere · 2h'), lockedScreen);
  assert.ok(!lockedScreen.includes('esc to cancel'), lockedScreen);
  assert.ok(!lockedScreen.includes('close the other acc process'), lockedScreen);

  press(DOWN);
  await tick();
  press(ENTER);
  await tick();
  instance.unmount();

  assert.deepEqual(picked, ['free']);
});
