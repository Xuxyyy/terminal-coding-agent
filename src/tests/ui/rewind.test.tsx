import assert from 'node:assert/strict';
import test from 'node:test';
import {render} from 'ink';
import type OpenAI from 'openai';
import {SUMMARY_PREFIX} from '../../core/compact.js';
import {liveRecords, type SessionRecord} from '../../core/records.js';
import {Picker} from '../../ui/components/Picker.js';
import {
  NOTHING_TO_REWIND,
  REWIND_STOPS_AT_COMPACT,
  rewindEmpty,
  rewindLine,
  rewindRows,
} from '../../ui/rewind.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

function conversation(): OpenAI.ChatCompletionMessageParam[] {
  return [
    {role: 'system', content: 'rules'},
    {role: 'user', content: 'fix the failing cart test'},
    {role: 'assistant', content: 'fixed'},
    {role: 'user', content: 'also update the README'},
    {role: 'assistant', content: 'updated'},
    {role: 'user', content: 'now make it handle an empty cart'},
  ];
}

const USAGE = {prompt: 10, completion: 5, total: 15};

function asked(id: string, text: string): SessionRecord[] {
  return [
    {kind: 'message', id, message: {role: 'user', content: text}},
    {
      kind: 'messages',
      messages: [
        {role: 'user', content: text},
        {role: 'assistant', content: 'done'},
      ],
      usage: USAGE,
    },
  ];
}

function records(): SessionRecord[] {
  return [
    ...asked('aa', 'fix the failing cart test'),
    ...asked('bb', 'also update the README'),
    ...asked('cc', 'now make it handle an empty cart'),
  ];
}

function drawn(rows: ReturnType<typeof rewindRows>): string[] {
  let buffer = '';
  const stdout = {
    columns: 60,
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
    <Picker
      title="Rewind to before a message"
      rows={rows}
      hint="↑↓ to move · enter to rewind · esc to cancel"
      empty="Nothing to rewind yet."
      renderRow={rewindLine}
      onPick={() => {}}
      onCancel={() => {}}
      initial={rows.length - 1}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  instance.unmount();
  return buffer.replace(ANSI, '').split('\n');
}

test('the picker lists one row per user message', () => {
  const rows = rewindRows(records());

  assert.deepEqual(
    rows.map((row) => row.title),
    ['fix the failing cart test', 'also update the README', 'now make it handle an empty cart'],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['aa', 'bb', 'cc'],
  );
  assert.deepEqual(
    rows.map((row) => row.at),
    [0, 2, 4],
  );
});

test('the rows the picker offered still name the same messages after a rewind', () => {
  const all = records();
  const rows = rewindRows(all);

  const after = rewindRows(liveRecords([...all, {kind: 'rewind', to: rows[2]!.at}]));

  assert.deepEqual(
    after.map((row) => row.id),
    ['aa', 'bb'],
  );
  assert.deepEqual(
    after.map((row) => row.title),
    rows.slice(0, 2).map((row) => row.title),
  );
});

test('the newest checkpoint is selected first', () => {
  const lines = drawn(rewindRows(records()));

  const marked = lines.filter((line) => line.includes('❯'));
  assert.equal(marked.length, 1);
  assert.match(marked[0]!, /now make it handle an empty cart/);
});

test('a long message is truncated to the width', () => {
  const row = {id: 'aa', at: 0, title: 'a'.repeat(80)};

  const line = rewindLine(row, true, 30);

  assert.equal(line.length, 30);
  assert.ok(line.endsWith('…'));
  assert.ok(line.startsWith('❯ '));
});

test('an empty conversation offers nothing to rewind', () => {
  const rows = rewindRows([]);

  assert.deepEqual(rows, []);
  assert.ok(drawn(rows).some((line) => line.includes(NOTHING_TO_REWIND)));
});

test('a compacted conversation says why nothing is rewindable', () => {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {role: 'system', content: 'rules'},
    {role: 'assistant', content: `${SUMMARY_PREFIX}we fixed the cart`},
  ];

  assert.deepEqual(
    rewindRows([...records(), {kind: 'compact', summary: 'we fixed the cart', replaced: 6}]),
    [],
  );
  assert.equal(rewindEmpty(messages), REWIND_STOPS_AT_COMPACT);
});

test('an untouched conversation keeps the plain empty line', () => {
  assert.equal(rewindEmpty(conversation()), NOTHING_TO_REWIND);
});
