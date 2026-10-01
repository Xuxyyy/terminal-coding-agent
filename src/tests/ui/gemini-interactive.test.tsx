import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {render} from 'ink';
import {ModelTimeoutError} from '../../core/client.js';
import {geminiClient} from '../../core/gemini.js';
import {loadSession} from '../../core/store.js';
import {App} from '../../ui/app.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

function input() {
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

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('interactive Gemini text appears progressively, runs a local tool, and stops on esc', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-ui-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-home-'));
  const oldHome = process.env.ACC_HOME;
  process.env.ACC_HOME = home;
  fs.writeFileSync(path.join(root, 'note.txt'), 'local note');
  let releaseFirst = () => {};
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondSignal: AbortSignal | undefined;
  let calls = 0;
  const client = geminiClient('test-key', async (_request, signal) => {
    calls += 1;
    if (calls === 1) return (async function* () {
      yield {event_type: 'step.start', index: 0, step: {type: 'model_output'}};
      yield {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'Reading'}};
      await firstHeld;
      yield {event_type: 'step.start', index: 1, step: {
        type: 'function_call', id: 'read-1', name: 'read_file', arguments: {path: 'note.txt'},
      }};
      yield {event_type: 'interaction.completed', interaction: {
        status: 'requires_action', usage: {total_input_tokens: 5, total_output_tokens: 3},
      }};
    })();
    secondSignal = signal;
    return (async function* () {
      yield {event_type: 'step.start', index: 0, step: {type: 'model_output'}};
      yield {event_type: 'step.delta', index: 0, delta: {type: 'text', text: 'Found it'}};
      await new Promise<never>(() => {});
    })();
  });
  const frames: string[] = [];
  const stdout = {
    columns: 100, rows: 40, isTTY: true,
    write(chunk: string) { frames.push(chunk.replace(ANSI, '')); },
    on() {}, off() {}, removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const {stdin, press} = input();
  const instance = render(
    <App workspaceRoot={root} choice={{
      client, model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576,
    }} onCleanExit={() => {}} />,
    {stdin, stdout, patchConsole: false, exitOnCtrlC: false},
  );
  try {
    press('read note.txt');
    await new Promise((resolve) => setTimeout(resolve, 60));
    press('\r');
    await until(() => frames.some((frame) => frame.includes('Reading')), 'first text never appeared');
    assert.equal(calls, 1, 'text should appear before the request finishes');
    releaseFirst();
    await until(() => calls === 2, 'the local tool did not lead to a second model request');
    await until(() => frames.some((frame) => frame.includes('Found it')), 'second text never appeared');
    const stored = loadSession(root, null, home);
    assert.ok(stored.messages.some((message) => message.role === 'tool' &&
      String(message.content).includes('local note')));
    press(ESC);
    await until(() => frames.some((frame) => frame.includes('stopped')), 'esc did not stop the turn');
    assert.equal(secondSignal?.aborted, true);
  } finally {
    instance.unmount();
    if (oldHome === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = oldHome;
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('interactive Gemini timeout shows an error and returns to the prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-ui-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gemini-home-'));
  const oldHome = process.env.ACC_HOME;
  process.env.ACC_HOME = home;
  const frames: string[] = [];
  const stdout = {
    columns: 100, rows: 40, isTTY: true,
    write(chunk: string) { frames.push(chunk.replace(ANSI, '')); },
    on() {}, off() {}, removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const {stdin, press} = input();
  const client = geminiClient('test-key', async () => { throw new ModelTimeoutError(120_000); });
  const instance = render(
    <App workspaceRoot={root} choice={{
      client, model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576,
    }} onCleanExit={() => {}} />,
    {stdin, stdout, patchConsole: false, exitOnCtrlC: false},
  );
  try {
    press('hello');
    await new Promise((resolve) => setTimeout(resolve, 60));
    press('\r');
    await until(() => frames.some((frame) => frame.includes('Gemini did not finish within 120 seconds')),
      'timeout error was not shown');
    assert.ok(frames.some((frame) => frame.includes('check your Gemini connection')));
    assert.ok(frames.at(-1)?.includes('❯'), 'the prompt did not return');
  } finally {
    instance.unmount();
    if (oldHome === undefined) delete process.env.ACC_HOME;
    else process.env.ACC_HOME = oldHome;
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  }
});
