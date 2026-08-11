import assert from 'node:assert/strict';
import test from 'node:test';
import {commandMatches, completeCommand} from '../../ui/components/CommandInput.js';

test('the menu offers only the commands this version has', () => {
  assert.deepEqual(
    commandMatches('/').map((command) => command.value),
    ['/context', '/clear'],
  );
});

test('a dropped command is not suggested', () => {
  assert.deepEqual(commandMatches('/per'), []);
  assert.deepEqual(commandMatches('/model'), []);
  assert.equal(completeCommand('/per'), '/per');
});

test('completeCommand picks the highlighted match, not always the first', () => {
  assert.deepEqual(
    commandMatches('/c').map((command) => command.value),
    ['/context', '/clear'],
  );
  assert.equal(completeCommand('/c', 0), '/context');
  assert.equal(completeCommand('/c', 1), '/clear');
});

test('completeCommand leaves the input alone when the index misses', () => {
  assert.equal(completeCommand('/c', 9), '/c');
  assert.equal(completeCommand('hello', 0), 'hello');
});
