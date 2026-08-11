import assert from 'node:assert/strict';
import test from 'node:test';
import {render} from 'ink';
import {HistoryList} from './components/history/HistoryList.js';
import type {Item} from './events.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

function renderHistory(items: Item[], awaitingApproval: boolean): string {
  let buffer = '';
  const stdout = {
    columns: 200,
    rows: 40,
    isTTY: true,
    write(chunk: string) {
      buffer += chunk;
    },
    on() {},
    off() {},
    removeListener() {},
  };
  const instance = render(
    <HistoryList items={items} awaitingApproval={awaitingApproval} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  instance.unmount();
  return buffer.split(ANSI).join('');
}

const started: Item[] = [
  {
    kind: 'event',
    event: {
      type: 'tool_start',
      id: 'c1',
      name: 'bash',
      args: {command: 'npm test'},
    },
  },
];

const stale: Item[] = [
  ...started,
  {
    kind: 'event',
    event: {
      type: 'tool_start',
      id: 'c2',
      name: 'bash',
      args: {command: 'git push'},
    },
  },
];

test('a started tool reads as running while nothing is being confirmed', () => {
  const output = renderHistory(started, false);

  assert.match(output, /running…/);
  assert.doesNotMatch(output, /waiting for approval/);
});

test('a started tool reads as waiting while an approval is open', () => {
  const output = renderHistory(started, true);

  assert.match(output, /waiting for approval…/);
  assert.doesNotMatch(output, /running…/);
});

test('only the tool being confirmed reads as waiting', () => {
  const output = renderHistory(stale, true);

  assert.match(output, /waiting for approval…/);
  assert.match(output, /running…/);
});
