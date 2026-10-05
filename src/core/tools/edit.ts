import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveTarget} from './paths.js';
import {fileOperation} from '../sandbox/files.js';

const schema = z.object({
  path: z.string().describe('File to change, relative to the workspace root.'),
  old_string: z
    .string()
    .describe(
      'Exact text to replace. It must appear exactly once in the file, so include surrounding lines when needed.',
    ),
  new_string: z.string().describe('Text to put in its place.'),
});

export const editFile: Tool = {
  name: 'edit_file',
  description:
    'Replace one exact, unique piece of text in a file. Read the file first so old_string matches byte for byte.',
  schema,
  request(args) {
    return {kind: 'write', path: schema.parse(args).path};
  },
  async run(args, ctx) {
    const parsed = schema.parse(args);
    const target = resolveTarget(ctx.root, parsed.path);
    const shown = displayPath(ctx.root, target);
    const {before, after} = await fileOperation({kind: 'edit', target, old: parsed.old_string, replacement: parsed.new_string, display: shown}, ctx);
    return {
      text: `Edited '${shown}'.`,
      diff: diffPayload(shown, before, after),
    };
  },
};
