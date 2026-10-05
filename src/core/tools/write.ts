import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveTarget} from './paths.js';
import {fileOperation} from '../sandbox/files.js';

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
  request(args) {
    return {kind: 'write', path: schema.parse(args).path};
  },
  async run(args, ctx) {
    const parsed = schema.parse(args);
    const target = resolveTarget(ctx.root, parsed.path);
    const shown = displayPath(ctx.root, target);
    const {before} = await fileOperation({kind: 'write', target, content: parsed.content}, ctx);
    return {
      text: `Wrote ${parsed.content.length} chars to '${shown}'.`,
      diff: diffPayload(shown, before, parsed.content),
    };
  },
};
