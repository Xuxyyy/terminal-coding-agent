import * as fs from 'node:fs';
import * as path from 'node:path';
import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveInWorkspace} from './paths.js';

const schema = z.object({
  path: z
    .string()
    .describe('File to write, relative to the workspace root. Parent directories are created.'),
  content: z.string().describe('Full contents of the file.'),
});

export const writeFile: Tool = {
  name: 'write_file',
  description:
    'Create a file or replace its whole contents. Prefer edit_file when changing part of an existing file.',
  schema,
  async run(args, ctx) {
    const parsed = schema.parse(args);
    const target = resolveInWorkspace(ctx.root, parsed.path);
    const shown = displayPath(ctx.root, target);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, parsed.content, 'utf8');
    return {
      text: `Wrote ${parsed.content.length} chars to '${shown}'.`,
      diff: diffPayload(shown, before, parsed.content),
    };
  },
};
