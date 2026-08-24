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
