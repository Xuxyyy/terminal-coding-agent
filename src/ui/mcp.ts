import type {ServerStatus} from '../core/mcp/connect.js';
import {userSettingsFile} from '../core/settings.js';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toolCount(tools: number): string {
  return tools === 1 ? '1 tool' : `${tools} tools`;
}

function serverLine(status: ServerStatus): string {
  if (status.state === 'failed') {
    return `${status.label} — failed: ${oneLine(status.error ?? 'no reason given')}`;
  }
  return `${status.label} — ready, ${toolCount(status.tools)}`;
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
