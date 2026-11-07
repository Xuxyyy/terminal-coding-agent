import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveTarget} from './paths.js';
import {fileOperation} from '../sandbox/files.js';

const schema = z.object({
  path: z.string().describe('Existing file to change. Relative paths are resolved from the workspace root.'),
  old_string: z
    .string()
    .describe(
      'Non-empty text to match exactly, including whitespace. Include surrounding lines when needed to identify one location.',
    ),
  new_string: z.string().describe('Text to put in its place.'),
});

export const editFile: Tool = {
  name: 'edit_file',
  description:
    'Replace one exact text match in an existing UTF-8 text file. Read the relevant content before editing. ' +
    'The tool rejects an empty old_string, no match, or multiple non-overlapping matches. ' +
    'Success confirms the replacement was applied. Verify the affected behavior when needed.',
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
      failure: false,
      text: `Edited '${shown}'.`,
      diff: diffPayload(shown, before, after),
    };
  },
};
