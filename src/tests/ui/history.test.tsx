import assert from 'node:assert/strict';
import test from 'node:test';
import {render} from 'ink';
import {
  HistoryList,
  historyRows,
  splitRows,
} from '../../ui/components/history/HistoryList.js';
import type {Item} from '../../ui/events.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

function renderHistory(items: Item[]): string {
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
  const instance = render(<HistoryList items={items} awaitingApproval={false} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return buffer.split(ANSI).join('');
}

test('historyRows pairs a tool result with its call', () => {
  const items: Item[] = [
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'c1', name: 'bash', args: {command: 'ls'}},
    },
    {kind: 'notice', text: 'stopped'},
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'c1',
        name: 'bash',
        result: '[exit 0]',
        diff: null,
      },
    },
  ];

  const rows = historyRows(items);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    kind: 'tool',
    id: 'tool:0',
    name: 'bash',
    args: {command: 'ls'},
    result: '[exit 0]',
    diff: null,
  });
  assert.equal(rows[1]?.kind, 'standard');
});

test('historyRows pairs by call id, not by tool name', () => {
  const rows = historyRows([
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'a', name: 'bash', args: {command: 'ls'}},
    },
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'b', name: 'bash', args: {command: 'pwd'}},
    },
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'b',
        name: 'bash',
        result: '[exit 0]\n/w',
        diff: null,
      },
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.kind === 'tool' ? rows[0].result : 'x', null);
  assert.equal(rows[1]?.kind === 'tool' ? rows[1].result : null, '[exit 0]\n/w');
});

test('historyRows keeps an unmatched result visible', () => {
  const rows = historyRows([
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'gone',
        name: 'bash',
        result: '[exit 0]',
        diff: null,
      },
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'standard');
});

test('splitRows prints every row once the last tool has its result', () => {
  const rows = historyRows([
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'c1', name: 'bash', args: {command: 'ls'}},
    },
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'c1',
        name: 'bash',
        result: '[exit 0]',
        diff: null,
      },
    },
  ]);

  assert.deepEqual(splitRows(rows), {done: rows, live: []});
});

test('splitRows holds back a running tool and the rows after it', () => {
  const rows = historyRows([
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'c1', name: 'bash', args: {command: 'ls'}},
    },
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'c1',
        name: 'bash',
        result: '[exit 0]',
        diff: null,
      },
    },
    {
      kind: 'event',
      event: {
        type: 'tool_start',
        id: 'c2',
        name: 'read_file',
        args: {path: 'a.ts'},
      },
    },
    {kind: 'notice', text: 'stopped'},
  ]);

  const {done, live} = splitRows(rows);

  assert.deepEqual(done, rows.slice(0, 1));
  assert.deepEqual(live, rows.slice(1));
});

test('splitRows holds back the header until the session is ready', () => {
  const starting = historyRows([{kind: 'header', workspaceRoot: '/w'}]);

  assert.deepEqual(splitRows(starting), {done: [], live: starting});
});

test('splitRows prints the header once it carries the ready details', () => {
  const ready = historyRows([
    {
      kind: 'header',
      workspaceRoot: '/w',
      ready: {
        workspace: '/w',
        model: {id: 'm', label: 'Model'},
        permission: {id: 'p'},
      },
    },
  ]);

  assert.deepEqual(splitRows(ready), {done: ready, live: []});
});

test('splitRows keeps a stale unpaired tool printable', () => {
  const rows = historyRows([
    {
      kind: 'event',
      event: {type: 'tool_start', id: 'c1', name: 'bash', args: {command: 'ls'}},
    },
    {
      kind: 'event',
      event: {
        type: 'tool_start',
        id: 'c2',
        name: 'read_file',
        args: {path: 'a.ts'},
      },
    },
    {
      kind: 'event',
      event: {
        type: 'tool_end',
        id: 'c2',
        name: 'read_file',
        result: 'x = 1',
        diff: null,
      },
    },
  ]);

  assert.deepEqual(splitRows(rows), {done: rows, live: []});
});

test('a model item draws its label between the divider rules', () => {
  const screen = renderHistory([{kind: 'model', id: 'glm-5.2', label: 'GLM 5.2'}]);

  const line = screen
    .split('\n')
    .find((row) => row.includes('GLM 5.2'));
  assert.ok(line, screen);
  assert.match(line!, /^─+ GLM 5\.2 ─+\s*$/);
});

test('a model label too wide for the divider is elided, not wrapped', () => {
  const label = 'M'.repeat(200);
  const screen = renderHistory([{kind: 'model', id: 'long', label}]);

  const drawn = screen.split('\n').filter((row) => row.includes('MMM'));
  assert.equal(drawn.length, 1, screen);
  assert.ok(drawn[0]!.includes('…'), drawn[0]);
  assert.ok(drawn[0]!.trimEnd().length <= 72, String(drawn[0]!.length));
});
