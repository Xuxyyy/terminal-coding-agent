import type {ServerStatus} from '../core/mcp/connect.js';
import {userSettingsFile} from '../core/settings.js';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toolCount(tools: number): string {
  return tools === 1 ? '1 tool' : `${tools} tools`;
}

function published(status: ServerStatus): string {
  return status.tools.length === status.listed
    ? toolCount(status.listed)
    : `${status.tools.length} of ${toolCount(status.listed)}`;
}

function unmatchedNote(unmatched: string[]): string {
  if (unmatched.length === 0) return '';
  const patterns = unmatched.map((pattern) => `"${pattern}"`).join(', ');
  return ` (no tool matches ${patterns})`;
}

function serverLine(status: ServerStatus): string {
  if (status.state === 'failed') {
    return `${status.label} — failed: ${oneLine(status.error ?? 'no reason given')}`;
  }
  if (status.state === 'disabled') {
    return `${status.label} — disabled`;
  }
  return (
    `${status.label} — ready, ${published(status)}` +
    unmatchedNote(status.unmatched)
  );
}

export function mcpReadout(statuses: ServerStatus[]): string {
  if (statuses.length === 0) {
    return (
      'no MCP servers configured — add an "mcpServers" block to ' +
      userSettingsFile()
    );
  }
  return statuses.map(serverLine).join('\n');
}
