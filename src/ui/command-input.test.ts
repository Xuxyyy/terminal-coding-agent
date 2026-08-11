import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandMatches,
  completeCommand,
} from './components/CommandInput.js';

test('permissions command is suggested and completed', () => {
  assert.deepEqual(commandMatches('/per'), [
    {
      value: '/permissions',
      description: 'change permission mode',
    },
  ]);
  assert.equal(completeCommand('/per'), '/permissions');
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
