import assert from 'node:assert/strict';
import test from 'node:test';
import {commandMatches, completeCommand} from '../../ui/components/CommandInput.js';

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
