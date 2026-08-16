import assert from 'node:assert/strict';
import test from 'node:test';
import {render} from 'ink';
import stringWidth from 'string-width';
import {liveRecords, type SessionRecord} from '../../core/records.js';
import {Picker} from '../../ui/components/Picker.js';
import {
  DELETED_MARK,
  RewindConfirm,
  SHELL_CAVEAT,
  SHOWN_FILES,
} from '../../ui/components/RewindConfirm.js';
import type {RewindFile} from '../../ui/events.js';
import {
  BEFORE_SUMMARY,
  NOTHING_TO_REWIND,
  rewindLine,
  rewindRows,
} from '../../ui/rewind.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

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

function compacted(): SessionRecord[] {
  return [...records(), {kind: 'compact', summary: 'we fixed the cart', replaced: 6}];
}

function screen(draw: (stdout: NodeJS.WriteStream) => ReturnType<typeof render>): string[] {
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
  } as unknown as NodeJS.WriteStream;
  const instance = draw(stdout);
  instance.unmount();
  return buffer.replace(ANSI, '').split('\n');
}

function drawnConfirm(files: RewindFile[]): string[] {
  return screen((stdout) =>
    render(
      <RewindConfirm
        title="fix the cart"
        files={files}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      {stdout, patchConsole: false, exitOnCtrlC: false},
    ),
  );
}

function drawn(rows: ReturnType<typeof rewindRows>): string[] {
  return screen((stdout) =>
    render(
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
      {stdout, patchConsole: false, exitOnCtrlC: false},
    ),
  );
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
  const row = {id: 'aa', at: 0, title: 'a'.repeat(80), beforeSummary: false};

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

test('only the rows older than the summary are marked', () => {
  const rows = rewindRows([...compacted(), ...asked('dd', 'and the total')]);

  assert.deepEqual(
    rows.map((row) => row.beforeSummary),
    [true, true, true, false],
  );
  const lines = rows.map((row) => rewindLine(row, false, 60));
  assert.equal(lines.filter((line) => line.endsWith(BEFORE_SUMMARY)).length, 3);
  assert.ok(lines[3]!.endsWith('and the total'));
});

test('a session with no compaction keeps the plain rows', () => {
  const rows = rewindRows(records());

  assert.deepEqual(
    rows.map((row) => row.beforeSummary),
    [false, false, false],
  );
  assert.equal(rewindLine(rows[0]!, false, 60), '  fix the failing cart test');
});

test('a narrow width cuts the title and keeps the mark whole', () => {
  const [row] = rewindRows(compacted());

  const line = rewindLine({...row!, title: 'a'.repeat(80)}, true, 40);

  assert.ok(line.endsWith(BEFORE_SUMMARY));
  assert.equal(stringWidth(line), 40);
  assert.ok(line.includes('…'));
});

function file(target: string, deleted = false): RewindFile {
  return {path: target, deleted};
}

test('only the files that did not exist yet are marked as deleted', () => {
  const lines = drawnConfirm([file('cart.ts'), file('note.txt', true)]);

  const cart = lines.find((line) => line.includes('cart.ts'));
  const note = lines.find((line) => line.includes('note.txt'));
  assert.ok(cart && note, 'expected both files on the screen');
  assert.equal(cart.includes(DELETED_MARK), false);
  assert.ok(note.includes(DELETED_MARK));
  assert.ok(lines.some((line) => line.includes('2 files will be restored')));
});

test('a long list of files is capped and says how many are left', () => {
  const many = Array.from({length: 14}, (_, n) => file(`src/f${n}.ts`));

  const lines = drawnConfirm(many);

  const listed = lines.filter((line) => /src\/f\d+\.ts/.test(line));
  assert.equal(listed.length, SHOWN_FILES);
  assert.ok(lines.some((line) => line.includes('… and 4 more')));
  assert.ok(lines.some((line) => line.includes('14 files will be restored')));
});

function flowed(lines: string[]): string {
  return lines
    .map((line) => line.replace(/[│╭╮╰╯─]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

test('the shell caveat is printed however many files there are', () => {
  const one = drawnConfirm([file('cart.ts')]);
  const many = drawnConfirm([file('cart.ts'), file('total.ts'), file('note.txt', true)]);

  assert.ok(flowed(one).includes(SHELL_CAVEAT));
  assert.ok(flowed(many).includes(SHELL_CAVEAT));
  assert.ok(one.some((line) => line.includes('1 file will be restored')));
});

test('a summary does not hide the messages before it', () => {
  const rows = rewindRows([...compacted(), ...asked('dd', 'and the total')]);

  assert.deepEqual(
    rows.map((row) => row.title),
    [
      'fix the failing cart test',
      'also update the README',
      'now make it handle an empty cart',
      'and the total',
    ],
  );
});
