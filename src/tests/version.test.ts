import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';
import {packageVersion} from '../version.js';

test('packageVersion reads the installed package manifest', () => {
  const file = new URL('../../package.json', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {version: string};

  assert.equal(packageVersion(), manifest.version);
});
