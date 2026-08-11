import assert from 'node:assert/strict';
import test from 'node:test';
import {Box, render} from 'ink';
import stringWidth from 'string-width';
import {Markdown} from './components/Markdown.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

function widestRenderedLine(text: string, columns: number): number {
  let buffer = '';
  const stdout = {
    columns,
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
    <Box flexDirection="column">
      <Markdown text={text} />
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  instance.unmount();
  const lines = buffer.split(ANSI).join('').split('\n');
  return Math.max(...lines.map((line) => stringWidth(line)));
}

const LONG =
  'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt';
const CJK = '這是一個很長的中文句子用來測試終端機的換行行為'.repeat(3);

const DOCUMENTS: Array<[string, string]> = [
  ['paragraph', LONG],
  ['bullet list', `- ${LONG}\n- ${LONG}`],
  ['ordered list', `9. ${LONG}\n10. ${LONG}`],
  ['nested bullets', `- top\n  - ${LONG}\n    - ${LONG}`],
  ['blockquote', `> ${LONG}`],
  ['quoted list', `> - ${LONG}`],
  ['code block', `\`\`\`\n${LONG}\n\`\`\``],
  ['wide characters', `- ${CJK}`],
  ['unbroken token', `- ${'x'.repeat(200)}`],
];

for (const [name, text] of DOCUMENTS) {
  test(`markdown keeps ${name} inside the terminal width`, () => {
    for (const columns of [40, 62, 80]) {
      assert.ok(
        widestRenderedLine(text, columns) <= columns,
        `${name} overflowed at ${columns} columns`,
      );
    }
  });
}
