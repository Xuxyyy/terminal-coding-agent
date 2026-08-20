import type {Mode} from '../permission/mode.js';
import {bash} from './bash.js';
import {editFile} from './edit.js';
import {grep} from './grep.js';
import {readFile} from './read.js';
import type {Tool} from './registry.js';
import {writeFile} from './write.js';

export const tools: Tool[] = [readFile, grep, editFile, writeFile, bash];

export function toolsFor(mode: Mode): Tool[] {
  return tools;
}

export {toolDefinitions, runTool} from './registry.js';
export type {Tool, ToolContext, ToolOutput} from './registry.js';
