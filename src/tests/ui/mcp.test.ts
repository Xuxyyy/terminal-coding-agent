import assert from 'node:assert/strict';
import test from 'node:test';
import type {ServerStatus} from '../../core/mcp/connect.js';
import {userSettingsFile} from '../../core/settings.js';
import {mcpReadout} from '../../ui/mcp.js';

function names(count: number): string[] {
  return Array.from({length: count}, (_value, index) => `tool_${index + 1}`);
}

function ready(label: string, tools: number): ServerStatus {
  return {
    label,
    state: 'ready',
    tools: names(tools),
    listed: tools,
    unmatched: [],
    error: null,
  };
}

function filtered(
  label: string,
  tools: number,
  listed: number,
  unmatched: string[] = [],
): ServerStatus {
  return {label, state: 'ready', tools: names(tools), listed, unmatched, error: null};
}

function disabled(label: string): ServerStatus {
  return {label, state: 'disabled', tools: [], listed: 0, unmatched: [], error: null};
}

function failed(label: string, error: string): ServerStatus {
  return {label, state: 'failed', tools: [], listed: 0, unmatched: [], error};
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

test('a filtered server says how many of how many it published', () => {
  const readout = (tools: number) => mcpReadout([filtered('github', tools, 45)]);

  assert.equal(readout(6), 'github — ready, 6 of 45 tools');
  assert.equal(readout(0), 'github — ready, 0 of 45 tools');
});

test('one published tool out of many keeps the count, not the unfiltered singular', () => {
  assert.equal(
    mcpReadout([filtered('github', 1, 45)]),
    'github — ready, 1 of 45 tools',
  );
  assert.equal(
    mcpReadout([filtered('github', 0, 1)]),
    'github — ready, 0 of 1 tool',
  );
});

test('a disabled server reads as disabled and carries no count', () => {
  assert.equal(mcpReadout([disabled('docs')]), 'docs — disabled');
});

test('a pattern that matched nothing is named on that server line', () => {
  assert.equal(
    mcpReadout([filtered('github', 3, 45, ['list_isues'])]),
    'github — ready, 3 of 45 tools (no tool matches "list_isues")',
  );
});

test('two patterns that matched nothing share one bracket', () => {
  assert.equal(
    mcpReadout([filtered('github', 3, 45, ['list_isues', 'get_fil'])]),
    'github — ready, 3 of 45 tools (no tool matches "list_isues", "get_fil")',
  );
});

test('a disabled server sits between the others without disturbing their lines', () => {
  assert.deepEqual(
    mcpReadout([
      ready('files', 1),
      disabled('docs'),
      filtered('github', 6, 45, ['nope']),
      failed('db', 'connection refused'),
    ]).split('\n'),
    [
      'files — ready, 1 tool',
      'docs — disabled',
      'github — ready, 6 of 45 tools (no tool matches "nope")',
      'db — failed: connection refused',
    ],
  );
});
