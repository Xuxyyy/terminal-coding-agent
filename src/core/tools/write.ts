import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveTarget} from './paths.js';
import {fileOperation} from '../sandbox/files.js';

const schema = z.object({
  path: z
    .string()
    .describe('File to write. Relative paths are resolved from the workspace root. Missing parent directories are created.'),
  content: z.string().describe('Full contents of the file.'),
});

export const writeFile: Tool = {
  name: 'write_file',
  description:
    'Create a UTF-8 file or replace an existing file’s whole contents. Inspect an existing file before overwriting it. ' +
    'Directory targets are rejected. Success confirms the supplied content was written. Verify the resulting file or affected behavior when needed. ' +
    'Prefer edit_file for changing part of an existing file.',
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
      failure: false,
      text: `Wrote ${parsed.content.length} chars to '${shown}'.`,
      diff: diffPayload(shown, before, parsed.content),
    };
  },
};
