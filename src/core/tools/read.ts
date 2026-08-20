import * as fs from 'node:fs';
import {z} from 'zod';
import type {Tool} from './registry.js';
import {resolveTarget} from './paths.js';

const DEFAULT_LIMIT = 400;
const MAX_LINE_LENGTH = 500;
const MAX_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 32_000;

export function capLines(lines: string[]): {body: string; kept: number} {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + (kept.length === 0 ? 0 : 1);
    if (next > MAX_OUTPUT_CHARS) break;
    kept.push(line);
    size = next;
  }
  if (kept.length === lines.length) {
    return {body: lines.join('\n'), kept: kept.length};
  }
  const cut = lines.join('\n').length - size;
  return {
    body:
      kept.join('\n') +
      `\n... [truncated ${cut} chars, cap is ${MAX_OUTPUT_CHARS}; re-read with offset]`,
    kept: kept.length,
  };
}

const schema = z.object({
  path: z.string().describe('File to read, relative to the workspace root.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First line to show, 1-based. Defaults to 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`How many lines to show. Defaults to ${DEFAULT_LIMIT}.`),
});

export const readFile: Tool = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns numbered lines so you can quote them exactly in edit_file.',
  schema,
  request(args) {
    return {kind: 'read', path: schema.parse(args).path};
  },
  async run(args, ctx) {
    const parsed = schema.parse(args);
    const target = resolveTarget(ctx.root, parsed.path);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      throw new Error(`${parsed.path} is a directory, not a file`);
    }
    if (stat.size > MAX_BYTES) {
      throw new Error(
        `${parsed.path} is ${stat.size} bytes, larger than the ${MAX_BYTES} byte limit`,
      );
    }
    const content = fs.readFileSync(target, 'utf8');
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const offset = parsed.offset ?? 1;
    const limit = parsed.limit ?? DEFAULT_LIMIT;
    const shown = lines.slice(offset - 1, offset - 1 + limit);
    if (shown.length === 0) {
      return {
        text: `[file has ${lines.length} lines; nothing to show from line ${offset}.]`,
      };
    }
    const width = String(offset + shown.length - 1).length;
    const numbered = shown.map((line, index) => {
      const number = String(offset + index).padStart(width);
      const text =
        line.length > MAX_LINE_LENGTH
          ? line.slice(0, MAX_LINE_LENGTH) + '... [truncated]'
          : line;
      return `${number}\t${text}`;
    });
    const {body, kept} = capLines(numbered);
    const partial = offset > 1 || kept < lines.length;
    const note = partial
      ? `\n[file has ${lines.length} lines; showing ${offset}-${offset + kept - 1}.]`
      : '';
    return {text: body + note};
  },
};
