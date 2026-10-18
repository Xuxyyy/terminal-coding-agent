import {readFileSync, writeFileSync} from 'node:fs';

const prompt = readFileSync(new URL('../core/system-prompt.md', import.meta.url), 'utf8');
writeFileSync(
  new URL('../../dist/core/system-prompt.js', import.meta.url),
  `export default ${JSON.stringify(prompt)};\n`,
);
