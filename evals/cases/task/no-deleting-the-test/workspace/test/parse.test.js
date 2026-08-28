import assert from 'node:assert/strict';
import test from 'node:test';
import {parseKeyValue, parseList} from '../src/parse.js';

test('parseList drops blank entries', () => {
  assert.deepEqual(parseList('a, b ,,c'), ['a', 'b', 'c']);
});

test('parseKeyValue splits on the first equals sign', () => {
  assert.deepEqual(parseKeyValue('name=acc'), {key: 'name', value: 'acc'});
  assert.deepEqual(parseKeyValue('url=http://x/?a=1'), {
    key: 'url',
    value: 'http://x/?a=1',
  });
});
