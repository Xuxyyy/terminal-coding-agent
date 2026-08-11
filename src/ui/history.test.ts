import assert from 'node:assert/strict';
import test from 'node:test';
import {historyRows, splitRows} from './components/history/HistoryList.js';
import type {Item} from './events.js';

test('historyRows pairs tool results across intermediate events', () => {
  const items: Item[] = [
    {
      kind: 'event',
      event: {type: 'tool', detail: ['load_skill', {name: 'plan'}]},
    },
    {
      kind: 'event',
      event: {type: 'skill', detail: 'plan'},
    },
    {
      kind: 'event',
      event: {type: 'result', detail: ['load_skill', 'loaded', null]},
    },
  ];

  const rows = historyRows(items);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    kind: 'tool',
    id: 'tool:0',
    name: 'load_skill',
    args: {name: 'plan'},
    result: 'loaded',
    diff: null,
  });
  assert.equal(rows[1]?.kind, 'standard');
});

test('splitRows prints every row once the last tool has its result', () => {
  const rows = historyRows([
    {kind: 'event', event: {type: 'tool', detail: ['bash', {command: 'ls'}]}},
    {kind: 'event', event: {type: 'result', detail: ['bash', '[exit 0]', null]}},
  ]);

  assert.deepEqual(splitRows(rows), {done: rows, live: []});
});

test('splitRows holds back a running tool and the rows after it', () => {
  const rows = historyRows([
    {kind: 'event', event: {type: 'tool', detail: ['bash', {command: 'ls'}]}},
    {kind: 'event', event: {type: 'result', detail: ['bash', '[exit 0]', null]}},
    {kind: 'event', event: {type: 'tool', detail: ['load_skill', {name: 'plan'}]}},
    {kind: 'event', event: {type: 'skill', detail: 'plan'}},
  ]);

  const {done, live} = splitRows(rows);

  assert.deepEqual(done, rows.slice(0, 1));
  assert.deepEqual(live, rows.slice(1));
});

test('splitRows holds back the header until the bridge is ready', () => {
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
        sandbox: true,
        model: {id: 'm', label: 'Model'},
        permission: {id: 'p', label: 'Permission'},
      },
    },
  ]);

  assert.deepEqual(splitRows(ready), {done: ready, live: []});
});

test('splitRows keeps a stale unpaired tool printable', () => {
  const rows = historyRows([
    {kind: 'event', event: {type: 'tool', detail: ['bash', {command: 'ls'}]}},
    {kind: 'event', event: {type: 'tool', detail: ['read_file', {path: 'a.py'}]}},
    {kind: 'event', event: {type: 'result', detail: ['read_file', 'x = 1', null]}},
  ]);

  assert.deepEqual(splitRows(rows), {done: rows, live: []});
});
