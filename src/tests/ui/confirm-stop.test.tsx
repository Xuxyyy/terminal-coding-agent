import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {render} from 'ink';
import {Confirm} from '../../ui/components/Confirm.js';
import type {ConfirmDecision, ConfirmRequest} from '../../ui/events.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

const HINT = 'esc to stop the turn';

const REQUEST: ConfirmRequest = {
  command: 'rm build.log',
  reason: "deletes 'build.log', which cannot be undone",
  suppressible: true,
};

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

async function mount(
  keys: string[],
): Promise<{answers: ConfirmDecision[]; stopped: number; screen: string}> {
  const answers: ConfirmDecision[] = [];
  let stopped = 0;
  const frames: string[] = [];
  const stdout = {
    columns: 60,
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
    <Confirm
      request={REQUEST}
      onRespond={(decision) => answers.push(decision)}
      onStop={() => {
        stopped += 1;
      }}
    />,
    {stdin, stdout, patchConsole: false, exitOnCtrlC: false},
  );
  await tick();
  for (const key of keys) {
    press(key);
    await tick();
  }
  instance.unmount();
  const screen = frames.filter((frame) => frame.includes(REQUEST.command)).pop() ?? '';
  return {answers, stopped, screen};
}

test('esc stops the turn instead of answering the request', async () => {
  const {answers, stopped} = await mount([ESC]);

  assert.equal(stopped, 1);
  assert.deepEqual(answers, []);
});

test('n still denies and stops nothing', async () => {
  const {answers, stopped} = await mount(['n']);

  assert.deepEqual(answers, ['deny']);
  assert.equal(stopped, 0);
});

test('y still approves once and stops nothing', async () => {
  const {answers, stopped} = await mount(['y']);

  assert.deepEqual(answers, ['once']);
  assert.equal(stopped, 0);
});

test('the box tells the reader that esc stops the turn', async () => {
  const {screen} = await mount([]);

  assert.ok(screen.includes(HINT), screen);
});
