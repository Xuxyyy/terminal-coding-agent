import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import type {SessionMeta} from '../../core/store.js';
import type {EventItem, NoticeItem, TaskItem, TextItem} from '../../ui/events.js';
import {restoreItems, restoreSummary, restoreView} from '../../ui/restore.js';

const meta: SessionMeta = {
  version: 1,
  id: 'a1b2c3d4',
  workspace: '/tmp/work',
  startedAt: '2026-08-11T10:04:00.000Z',
  updatedAt: '2026-08-11T11:20:00.000Z',
  status: 'closed',
  usage: {prompt: 900, completion: 100, total: 1_000},
};

test('a resumed session redraws the conversation', () => {
  const items = restoreItems([
    {role: 'system', content: 'rules'},
    {role: 'user', content: 'fix the cart'},
    {
      role: 'assistant',
      content: 'reading it',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {name: 'read_file', arguments: '{"path":"src/cart.js"}'},
        },
      ],
    },
    {role: 'tool', tool_call_id: 'c1', content: '[file has 3 lines]'},
    {role: 'assistant', content: 'fixed'},
  ]);

  assert.deepEqual(
    items.map((item) => item.kind),
    ['task', 'text', 'event', 'event', 'text'],
  );
  assert.equal((items[0] as TaskItem).text, 'fix the cart');
  assert.equal((items[1] as TextItem).text, 'reading it');
  assert.equal((items[4] as TextItem).text, 'fixed');

  const start = (items[2] as EventItem).event;
  if (start.type !== 'tool_start') assert.fail('expected a tool_start');
  assert.equal(start.id, 'c1');
  assert.equal(start.name, 'read_file');
  assert.deepEqual(start.args, {path: 'src/cart.js'});

  const end = (items[3] as EventItem).event;
  if (end.type !== 'tool_end') assert.fail('expected a tool_end');
  assert.equal(end.id, 'c1');
  assert.equal(end.name, 'read_file');
  assert.equal(end.result, '[file has 3 lines]');
  assert.equal(end.diff, null);
});

test('restoreSummary names the count and when it started', () => {
  const summary = restoreSummary(meta, 42);

  assert.match(summary, /^restored 42 messages from /);
  assert.match(summary, /2026-08-11/);
});

test('a resumed session shows a summary, not every turn', () => {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {role: 'system', content: 'rules'},
  ];
  for (let n = 1; n <= 30; n += 1) {
    messages.push({role: 'user', content: `task ${n}`});
    messages.push({role: 'assistant', content: `answer ${n}`});
  }

  const items = restoreView({meta, messages});
  const rendered = JSON.stringify(items);

  assert.equal(items[0]!.kind, 'notice');
  assert.match((items[0] as NoticeItem).text, /restored 61 messages/);
  assert.ok(items.length <= 4, `expected a short view, got ${items.length}`);
  assert.ok(rendered.includes('task 30'));
  assert.ok(rendered.includes('answer 30'));
  assert.ok(!rendered.includes('task 29'));
  assert.ok(!rendered.includes('answer 29'));
});
