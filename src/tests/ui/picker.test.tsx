import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {render} from 'ink';
import {Picker} from '../../ui/components/Picker.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

const ENTER = '\r';
const DOWN = `${ESC}[B`;

type Row = {id: string; label: string};

const ROWS: Row[] = [
  {id: 'open', label: 'open'},
  {id: 'shut', label: 'shut'},
];

const HINT = '↑↓ to move · enter to choose · esc to cancel';

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
  options: {
    disabled?: (row: Row) => boolean;
    disabledHint?: (row: Row) => string;
    initial?: number;
  } = {},
): Promise<{picked: string[]; cancelled: number; screen: string}> {
  const picked: string[] = [];
  let cancelled = 0;
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
    <Picker
      title="Choose one"
      rows={ROWS}
      hint={HINT}
      empty=""
      renderRow={(row, active) => `${active ? '❯ ' : '  '}${row.label}`}
      onPick={(id) => picked.push(id)}
      onCancel={() => {
        cancelled += 1;
      }}
      initial={options.initial ?? 0}
      disabled={options.disabled}
      disabledHint={options.disabledHint}
    />,
    {stdin, stdout, patchConsole: false, exitOnCtrlC: false},
  );
  await tick();
  for (const key of keys) {
    press(key);
    await tick();
  }
  const screen = frames.filter((frame) => frame.includes('Choose one')).pop() ?? '';
  instance.unmount();
  return {picked, cancelled, screen};
}

test('enter on a disabled row picks nothing and closes nothing', async () => {
  const {picked, cancelled} = await mount([ENTER], {
    disabled: (row) => row.id === 'open',
  });

  assert.deepEqual(picked, []);
  assert.equal(cancelled, 0);
});

test('enter on an enabled row still picks it', async () => {
  const {picked, cancelled} = await mount([ENTER], {
    disabled: (row) => row.id === 'shut',
  });

  assert.deepEqual(picked, ['open']);
  assert.equal(cancelled, 0);
});

test('a picker with no disabled prop picks the row under the cursor', async () => {
  assert.deepEqual((await mount([ENTER])).picked, ['open']);
});

test('the arrows still move onto a disabled row, which enter then refuses', async () => {
  const {picked} = await mount([DOWN, ENTER], {disabled: (row) => row.id === 'shut'});

  assert.deepEqual(picked, []);
});

test('the hint names the reason while the highlighted row is disabled', async () => {
  const {screen} = await mount([], {
    disabled: (row) => row.id === 'open',
    disabledHint: (row) => `${row.label} is out of reach`,
  });

  assert.ok(screen.includes('open is out of reach'), screen);
  assert.equal(screen.includes(HINT), false, screen);
});

test('the normal hint comes back once the highlighted row is pickable', async () => {
  const {screen} = await mount([DOWN], {
    disabled: (row) => row.id === 'open',
    disabledHint: (row) => `${row.label} is out of reach`,
  });

  assert.ok(screen.includes(HINT), screen);
  assert.equal(screen.includes('is out of reach'), false, screen);
});
