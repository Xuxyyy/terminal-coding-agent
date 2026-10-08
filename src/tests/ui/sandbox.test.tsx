import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {render} from 'ink';
import {App} from '../../ui/app.js';
import {loadSettings} from '../../core/settings.js';
import {sandboxLine, sandboxRows} from '../../ui/sandbox.js';
import {fakeModel, finishChunk, streamOf, textChunk, toolCallChunk} from '../fakes.js';

const ESC = '\u001b';
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const tick = () => new Promise((resolve) => setTimeout(resolve, 75));

test('sandbox rows mark the current mode and fit narrow terminals', () => {
  const rows = sandboxRows('off');
  assert.deepEqual(rows.map((row) => row.current), [true, false]);
  assert.match(sandboxLine(rows[0]!, true, 80).head, /Off \(current\)/);
  assert.ok(sandboxLine(rows[1]!, true, 10).head.length <= 10);
});

test('the real TUI selects and cancels sandbox mode and shows it during tasks and approvals', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sandbox-ui-'));
  const priorHome = process.env.ACC_HOME;
  process.env.ACC_HOME = path.join(root, 'acc-home');
  loadSettings([]);
  t.after(() => {
    if (priorHome === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = priorHome;
    fs.rmSync(root, {recursive: true, force: true});
  });
  const queue: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {isTTY: true, setRawMode: () => stdin, setEncoding: () => stdin,
    resume: () => stdin, pause: () => stdin, read: () => queue.shift() ?? null,
    ref: () => stdin, unref: () => stdin});
  const frames: string[] = [];
  const stdout = {columns: 100, rows: 32, isTTY: true,
    write(chunk: string) { frames.push(chunk.replace(ANSI, '')); },
    on() {}, off() {}, removeListener() {}} as unknown as NodeJS.WriteStream;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const {choice} = fakeModel((nth) => nth === 1 ? {
    async *[Symbol.asyncIterator]() {
      await held;
      yield toolCallChunk('call-1', 'bash', JSON.stringify({command: 'rm build.log'}));
      yield finishChunk('tool_calls');
    },
  } : streamOf(textChunk('done'), finishChunk('stop')));
  const instance = render(<App workspaceRoot={root} choice={choice} sandbox="on" onCleanExit={() => {}} />,
    {stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false});
  t.after(() => instance.unmount());
  const screen = () => frames.filter((frame) => frame.includes('Sandbox:')).at(-1) ?? '';
  const press = async (key: string) => { queue.push(key); stdin.emit('readable'); await tick(); };
  await tick();
  assert.match(screen(), /Sandbox: On/);
  await press('/sandbox');
  await press('\r');
  assert.match(screen(), /On \(current\)/);
  await press(ESC);
  assert.match(screen(), /Sandbox: On/);
  await press('/sandbox');
  await press('\r');
  await press(`${ESC}[A`);
  await press('\r');
  assert.match(screen(), /Sandbox: Off/);
  await press('/sandbox');
  await press('\r');
  await press(`${ESC}[B`);
  await press('\r');
  assert.match(screen(), /Sandbox: On/);
  await press('work');
  await press('\r');
  assert.match(screen(), /Sandbox: On/);
  assert.match(screen(), /esc to stop/);
  release();
  for (let index = 0; index < 30 && !screen().includes('rm build.log'); index++) await tick();
  assert.match(screen(), /Sandbox: On/);
  assert.match(screen(), /rm build.log/);
  await press(ESC);
  assert.match(screen(), /Sandbox: On/);
});
