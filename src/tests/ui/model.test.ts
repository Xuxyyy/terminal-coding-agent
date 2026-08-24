import assert from 'node:assert/strict';
import test from 'node:test';
import {MODELS, MODEL_IDS, keyEnvOf} from '../../core/models.js';
import {
  missingKeyHint,
  modelAt,
  modelLine,
  modelNotice,
  modelRows,
} from '../../ui/model.js';
import {CURRENT_MARK, NOT_REMEMBERED} from '../../ui/permission.js';

const NO_KEYS: NodeJS.ProcessEnv = {};

const EVERY_KEY: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: 'sk-deepseek',
  GLM_API_KEY: 'sk-glm',
  MOONSHOT_API_KEY: 'sk-moonshot',
};

test('the rows list every model in the order the registry keeps them', () => {
  const rows = modelRows('deepseek-v4-flash', EVERY_KEY);

  assert.deepEqual(
    rows.map((row) => row.id),
    MODEL_IDS,
  );
  for (const row of rows) assert.equal(row.label, MODELS[row.id]!.label);
});

test('the row for the model the session runs is the marked one', () => {
  const rows = modelRows('glm-5.2', EVERY_KEY);

  assert.deepEqual(
    rows.filter((row) => row.current).map((row) => row.id),
    ['glm-5.2'],
  );
});

test('the picker opens on the model the session is in', () => {
  for (const id of MODEL_IDS) {
    assert.equal(modelRows(id, EVERY_KEY)[modelAt(id)]!.id, id, id);
  }
});

test('the picker opens on the first model when the id is unknown', () => {
  assert.equal(modelAt('gpt-none'), 0);
  assert.equal(modelAt(''), 0);
});

test('a missing key is named by the variable the provider reads', () => {
  for (const row of modelRows('deepseek-v4-flash', NO_KEYS)) {
    assert.equal(row.missingKey, keyEnvOf(row.id), row.id);
  }
});

test('a key that is set leaves nothing missing on the row', () => {
  for (const row of modelRows('deepseek-v4-flash', EVERY_KEY)) {
    assert.equal(row.missingKey, null, row.id);
  }
});

test('an empty variable counts as no key at all', () => {
  const rows = modelRows('deepseek-v4-flash', {...EVERY_KEY, GLM_API_KEY: ''});

  assert.equal(rows.find((row) => row.id === 'glm-5.2')!.missingKey, 'GLM_API_KEY');
  assert.equal(
    rows.find((row) => row.id === 'deepseek-v4-flash')!.missingKey,
    null,
  );
});

test('only the label is in the part the picker bolds', () => {
  const rows = modelRows('deepseek-v4-flash', EVERY_KEY);
  const current = rows.find((row) => row.current)!;

  const active = modelLine(current, true, 80);
  assert.equal(active.head, `❯ DeepSeek v4 Flash${CURRENT_MARK}`);
  assert.equal(active.tail, ' — deepseek-v4-flash');

  const idle = modelLine(rows.find((row) => !row.current)!, false, 80);
  assert.equal(idle.head, '  Kimi K3');
  assert.equal(idle.head.includes(CURRENT_MARK), false);
});

test('a row without a key says which variable it needs instead of the id', () => {
  const row = modelRows('kimi-k3', NO_KEYS).find((r) => r.id === 'glm-4.7-flash')!;

  const {head, tail} = modelLine(row, false, 80);
  assert.equal(head, '  GLM 4.7 Flash');
  assert.equal(tail, ' — needs GLM_API_KEY');
});

test('a row is cut to the width it is given', () => {
  for (const row of modelRows('kimi-k3', EVERY_KEY)) {
    const whole = modelLine(row, true, 200);
    const width = whole.head.length + whole.tail.length - 4;

    const {head, tail} = modelLine(row, true, width);
    assert.ok(head.length + tail.length <= width, `${head}${tail}`);
    assert.ok(tail.endsWith('…'), `${row.id}: ${tail}`);
  }
});

test('a row too narrow for the id keeps the label alone', () => {
  const row = modelRows('deepseek-v4-flash', EVERY_KEY).find(
    (r) => r.id === 'deepseek-v4-flash',
  )!;

  const {head, tail} = modelLine(row, true, 12);
  assert.equal(tail, '');
  assert.ok(head.length <= 12, head);
  assert.ok(head.startsWith('❯ DeepSeek'), head);
});

test('the notice names the model that was picked', () => {
  for (const id of MODEL_IDS) {
    const label = MODELS[id]!.label;
    assert.equal(modelNotice(label), `switched to ${label}`);
  }
});

test('the notice says so when the pick could not be saved', () => {
  const notice = modelNotice('GLM 5.2', false);

  assert.ok(notice.includes('GLM 5.2'), notice);
  assert.ok(notice.endsWith(NOT_REMEMBERED), notice);
});

test('the hint tells the reader which variable to set', () => {
  const row = modelRows('kimi-k3', NO_KEYS).find((r) => r.id === 'kimi-k3')!;

  assert.equal(missingKeyHint(row), 'set MOONSHOT_API_KEY to use this model');
});
