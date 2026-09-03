import assert from 'node:assert/strict';
import test from 'node:test';
import {stricterMode, type Mode} from '../../../core/permission/mode.js';

test('the effective mode is the stricter of parent and configured modes', () => {
  const expected: Record<Mode, Record<Mode, Mode>> = {
    'ask-edits': {
      'ask-edits': 'ask-edits',
      'auto-edits': 'ask-edits',
      auto: 'ask-edits',
    },
    'auto-edits': {
      'ask-edits': 'ask-edits',
      'auto-edits': 'auto-edits',
      auto: 'auto-edits',
    },
    auto: {
      'ask-edits': 'ask-edits',
      'auto-edits': 'auto-edits',
      auto: 'auto',
    },
  };

  for (const parent of Object.keys(expected) as Mode[]) {
    for (const configured of Object.keys(expected[parent]) as Mode[]) {
      assert.equal(
        stricterMode(parent, configured),
        expected[parent][configured],
        `${parent} parent with ${configured} definition`,
      );
    }
  }
});
