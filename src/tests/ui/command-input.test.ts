import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandMatches,
  completeCommand,
  splitCommand,
} from '../../ui/components/CommandInput.js';

test('the menu offers only the commands this version has', () => {
  assert.deepEqual(
    commandMatches('/').map((command) => command.value),
    [
      '/context',
      '/compact',
      '/clear',
      '/resume',
      '/rewind',
      '/permission',
      '/model',
      '/mcp',
    ],
  );
});

test('a command this version does not have is not suggested', () => {
  assert.deepEqual(commandMatches('/models'), []);
  assert.equal(completeCommand('/models'), '/models');
});

test('/model completes from the first few letters', () => {
  assert.deepEqual(
    commandMatches('/mod').map((command) => command.value),
    ['/model'],
  );
  assert.equal(completeCommand('/mod'), '/model');
});

test('/mcp completes from the first few letters', () => {
  assert.deepEqual(
    commandMatches('/mc').map((command) => command.value),
    ['/mcp'],
  );
  assert.equal(completeCommand('/mc'), '/mcp');
});

test('/m offers the model switch first and the MCP readout second', () => {
  assert.deepEqual(
    commandMatches('/m').map((command) => command.value),
    ['/model', '/mcp'],
  );
  assert.equal(completeCommand('/m', 0), '/model');
  assert.equal(completeCommand('/m', 1), '/mcp');
});

test('/permission completes from the first few letters', () => {
  assert.deepEqual(
    commandMatches('/perm').map((command) => command.value),
    ['/permission'],
  );
  assert.equal(completeCommand('/perm'), '/permission');
});

test('completeCommand picks the highlighted match, not always the first', () => {
  assert.deepEqual(
    commandMatches('/c').map((command) => command.value),
    ['/context', '/compact', '/clear'],
  );
  assert.equal(completeCommand('/c', 0), '/context');
  assert.equal(completeCommand('/c', 1), '/compact');
  assert.equal(completeCommand('/c', 2), '/clear');
});

test('completeCommand leaves the input alone when the index misses', () => {
  assert.equal(completeCommand('/c', 9), '/c');
  assert.equal(completeCommand('hello', 0), 'hello');
});

test('a command with no argument splits to itself and an empty argument', () => {
  assert.deepEqual(splitCommand('/mcp'), {name: '/mcp', argument: ''});
  assert.deepEqual(splitCommand('  /mcp  '), {name: '/mcp', argument: ''});
});

test('a command with an argument splits at the first run of spaces', () => {
  assert.deepEqual(splitCommand('/mcp github'), {name: '/mcp', argument: 'github'});
  assert.deepEqual(splitCommand('/mcp   github'), {name: '/mcp', argument: 'github'});
  assert.deepEqual(splitCommand('/mcp github  '), {name: '/mcp', argument: 'github'});
});

test('only the first word is the command name, so /clear now is not /clear', () => {
  assert.equal(splitCommand('/clear now').name, '/clear');
  assert.notEqual('/clear now', '/clear');
});
