import * as fs from 'node:fs';
import {z} from 'zod';
import type {Tool} from './registry.js';
import {diffPayload} from './diff.js';
import {displayPath, resolveInWorkspace} from './paths.js';

const schema = z.object({
  path: z.string().describe('File to change, relative to the workspace root.'),
  old_string: z
    .string()
    .describe(
      'Exact text to replace. It must appear exactly once in the file, so include surrounding lines when needed.',
    ),
  new_string: z.string().describe('Text to put in its place.'),
});

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

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
    const target = resolveInWorkspace(ctx.root, parsed.path);
    const shown = displayPath(ctx.root, target);
    if (!fs.existsSync(target)) {
      throw new Error(`no such file: ${shown}`);
    }
    if (!parsed.old_string) {
      throw new Error('old_string is empty; use write_file to create a file');
    }
    const before = fs.readFileSync(target, 'utf8');
    const found = occurrences(before, parsed.old_string);
    if (found === 0) {
      throw new Error(`old_string not found in ${shown}`);
    }
    if (found > 1) {
      throw new Error(
        `old_string appears ${found} times in ${shown}; include more surrounding text so it matches once`,
      );
    }
    const after = before.replace(parsed.old_string, () => parsed.new_string);
    fs.writeFileSync(target, after, 'utf8');
    return {
      text: `Edited '${shown}'.`,
      diff: diffPayload(shown, before, after),
    };
  },
};
