import type {Mode} from '../permission/mode.js';
import {bash} from './bash.js';
import {editFile} from './edit.js';
import {grep} from './grep.js';
import {readFile} from './read.js';
import type {Tool} from './registry.js';
import {makeSubagent} from './subagent.js';
import {writeFile} from './write.js';

export const tools: Tool[] = [readFile, grep, editFile, writeFile, bash];

const AUTO_DESCRIPTIONS: Record<string, string> = {
  bash:
    'Run a shell command in the workspace root. Prefer this tool for reading, searching, and running commands, ' +
    'including tests, formatters, and generators. Prefer edit_file and write_file for ordinary file changes ' +
    'so /rewind can use their existing backups when available. This is a preference, not a restriction; shell edits remain allowed. ' +
    'Keep searches narrow and avoid sensitive files; shell searches do not inherit the grep tool\'s exclusions. ' +
    'Keep edits targeted. Shell changes are not backed up for /rewind, and git cannot reliably recover overwritten uncommitted work. ' +
    'Clean environment and private HOME/temp files. ' +
    'When Sandbox is On, network is off; request extra paths or network with access. Do not blindly retry blocked commands: earlier parts may have run.',
  read_file:
    'Read a text file from the workspace with bounded, numbered output. Prefer bash for reading; ' +
    'use this tool when its numbered lines, offset, or output limits offer a clear benefit.',
  grep:
    'Search file contents in the workspace with ripgrep. Returns matching file paths by default and respects .gitignore. ' +
    'Prefer bash for searching; use this tool when its search options, output limits, or sensitive-file exclusions offer a clear benefit.',
  edit_file:
    'Replace one exact, unique piece of text in a file. Read the file first so old_string matches byte for byte. ' +
    'Prefer this tool for changing part of an existing file so /rewind can use its existing backups when available.',
  write_file:
    'Create a file or replace its whole contents. Prefer this tool for creating files or replacing their whole contents ' +
    'so /rewind can use its existing backups when available. Prefer edit_file for changing part of an existing file.',
};

export function toolsFor(mode: Mode): Tool[] {
  const offered = mode === 'auto'
    ? tools.map((tool) => ({...tool, description: AUTO_DESCRIPTIONS[tool.name] ?? tool.description}))
    : tools;
  return [...offered, makeSubagent()];
}

export {toolDefinitions, runTool} from './registry.js';
export type {Tool, ToolContext, ToolOutput} from './registry.js';
