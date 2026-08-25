import assert from 'node:assert/strict';
import test from 'node:test';
import type {ServerStatus} from '../../core/mcp/connect.js';
import {userSettingsFile} from '../../core/settings.js';
import {mcpReadout} from '../../ui/mcp.js';

function ready(label: string, tools: number): ServerStatus {
  return {label, state: 'ready', tools, error: null};
}

function failed(label: string, error: string): ServerStatus {
  return {label, state: 'failed', tools: 0, error};
}

test('an empty list points at the user settings file', () => {
  const readout = mcpReadout([]);

  assert.ok(readout.includes(userSettingsFile()), readout);
  assert.ok(readout.startsWith('no MCP servers configured'), readout);
});

test('a ready server counts one tool in the singular and the rest in the plural', () => {
  assert.equal(mcpReadout([ready('docs', 1)]), 'docs — ready, 1 tool');
  assert.equal(mcpReadout([ready('docs', 2)]), 'docs — ready, 2 tools');
  assert.equal(mcpReadout([ready('docs', 0)]), 'docs — ready, 0 tools');
});

test('a failed server carries its error text', () => {
  assert.equal(
    mcpReadout([failed('github', 'spawn npx ENOENT')]),
    'github — failed: spawn npx ENOENT',
  );
});

test('a mixed list keeps one line per server, in the order given', () => {
  const readout = mcpReadout([
    failed('github', 'spawn npx ENOENT'),
    ready('docs', 3),
    failed('db', 'connection refused'),
    ready('files', 1),
  ]);

  assert.deepEqual(readout.split('\n'), [
    'github — failed: spawn npx ENOENT',
    'docs — ready, 3 tools',
    'db — failed: connection refused',
    'files — ready, 1 tool',
  ]);
});

test('an error spread over many lines is collapsed onto one', () => {
  const statuses = [
    failed('github', 'Error: could not start\n  at spawn ()\n\n  at run ()\n'),
    ready('docs', 2),
  ];

  const readout = mcpReadout(statuses);

  assert.equal(readout.split('\n').length, statuses.length);
  assert.equal(
    readout.split('\n')[0],
    'github — failed: Error: could not start at spawn () at run ()',
  );
});
