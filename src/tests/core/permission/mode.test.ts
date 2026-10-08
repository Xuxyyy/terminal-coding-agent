import assert from 'node:assert/strict';
import test from 'node:test';
import {aboveCut, stricterMode, withinCut, type Mode} from '../../../core/permission/mode.js';
import {TIER_RANK} from '../../../core/permission/classify.js';

test('modes distinguish exactly three tiers and never automatically approve needs-checking', () => {
  assert.deepEqual(Object.keys(TIER_RANK), ['observe', 'recoverable', 'needs-checking']);
  for (const mode of ['ask-edits', 'auto-edits', 'auto'] as const) {
    assert.equal(withinCut('observe', mode), true);
    assert.equal(withinCut('recoverable', mode), mode !== 'ask-edits');
    assert.equal(withinCut('needs-checking', mode), false);
    assert.equal(aboveCut(mode), mode === 'auto' ? 'judge' : 'ask');
  }
});

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
