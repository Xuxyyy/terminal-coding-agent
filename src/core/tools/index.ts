import type {Mode} from '../permission/mode.js';
import {bash, backgroundBash, BACKGROUND_INSTRUCTIONS, BASH_EXECUTION_GUIDANCE} from './bash.js';
import {editFile} from './edit.js';
import {grep} from './grep.js';
import {glob} from './glob.js';
import {readFile} from './read.js';
import type {Tool} from './registry.js';
import {makeSubagent} from './subagent.js';
import {writeFile} from './write.js';
import {taskOutput, taskStop, taskHandoff} from './tasks.js';
import {sendMessage, waitAgents, stopAgent} from './agent-messages.js';

export const tools: Tool[] = [readFile, grep, glob, editFile, writeFile, bash];

const AUTO_DESCRIPTIONS: Record<string, string> = {
  bash:
    'Run a shell command in the workspace root. Use this tool for ordinary file reads, searches, and running commands, ' +
    'including tests, formatters, and generators. Prefer edit_file and write_file for ordinary file changes ' +
    'so /rewind can use their existing backups when available. This is a preference, not a restriction; shell edits remain allowed. ' +
    'Keep searches narrow and avoid sensitive files; shell searches do not inherit the grep tool\'s exclusions. ' +
    'Keep edits targeted. Shell changes are not backed up for /rewind, and git cannot reliably recover overwritten uncommitted work. ' +
    BASH_EXECUTION_GUIDANCE,
  edit_file:
    editFile.description +
    ' Prefer this tool for changing part of an existing file so /rewind can use its existing backups when available.',
  write_file:
    writeFile.description +
    ' Prefer this tool for creating files or replacing their whole contents so /rewind can use its existing backups when available.',
};

export function toolsFor(mode: Mode, background = false): Tool[] {
  const offered = mode === 'auto'
    ? tools
      .filter((tool) => tool.name !== 'read_file' && tool.name !== 'grep' && tool.name !== 'glob')
      .map((tool) => ({...tool, description: AUTO_DESCRIPTIONS[tool.name] ?? tool.description}))
    : tools;
  const enabled = background ? offered.map((tool) => tool.name === 'bash'
    ? {...backgroundBash, description: tool.description + BACKGROUND_INSTRUCTIONS}
    : tool) : offered;
  return [...enabled, ...(background ? [taskOutput, taskStop, taskHandoff] : []), makeSubagent(), sendMessage, waitAgents, stopAgent];
}

export {toolDefinitions, runTool} from './registry.js';
export type {Tool, ToolContext, ToolOutput} from './registry.js';
