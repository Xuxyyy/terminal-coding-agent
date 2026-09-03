import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {ModelChoice} from '../../../core/client.js';
import {INTERRUPTED, type Host} from '../../../core/host.js';
import {subagentPrompt} from '../../../core/prompt.js';
import type {ToolContext} from '../../../core/tools/registry.js';
import {childHost, childTools, subagent} from '../../../core/tools/subagent.js';
import {
  fakeHost,
  fakeModel,
  finishChunk,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../../fakes.js';

const SECRET = 'SECRET-FROM-THE-TOOL';

const ANSWER = 'the note names one owner';

const job = {description: 'read a note', prompt: 'say who owns the note'};

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-subagent-')));
}

function context(root: string, host: Host, choice?: ModelChoice): ToolContext {
  return {
    root,
    host,
    allowed: new Set<string>(),
    rules: {allow: [], ask: [], deny: []},
    mode: 'auto-edits',
    choice,
  };
}

function readsThenAnswers(root: string) {
  fs.writeFileSync(path.join(root, 'notes.txt'), `${SECRET}\n`);
  const {choice, calls} = fakeModel((nth) =>
    nth === 1
      ? streamOf(
          toolCallChunk('call-1', 'read_file', JSON.stringify({path: 'notes.txt'})),
          finishChunk('tool_calls'),
          usageChunk(10, 2),
        )
      : streamOf(textChunk(ANSWER), finishChunk('stop'), usageChunk(3, 4)),
  );
  const sent: string[] = [];
  const create = choice.client.chat.completions.create;
  const client = {
    chat: {
      completions: {
        create: async (body: {messages: unknown}, options?: unknown) => {
          sent.push(JSON.stringify(body.messages));
          return create(body as never, options as never);
        },
      },
    },
  } as unknown as typeof choice.client;
  return {choice: {...choice, client}, calls, sent};
}

test('the parent is given the final message and none of the tool output', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const {choice, calls, sent} = readsThenAnswers(root);

  const output = await subagent.run(job, context(root, host, choice));

  assert.equal(calls(), 2);
  assert.ok(sent[1]!.includes(SECRET));
  assert.equal(output.text, ANSWER);
  assert.doesNotMatch(output.text, new RegExp(SECRET));
  assert.doesNotMatch(output.text, /notes\.txt/);
});

test('the usage the parent sees is the whole child turn', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const {choice} = readsThenAnswers(root);

  const output = await subagent.run(job, context(root, host, choice));

  assert.deepEqual(output.usage, {prompt: 13, completion: 6, total: 19});
});

test('a sub-agent is never offered a sub-agent of its own', () => {
  const names = childTools('auto-edits').map((tool) => tool.name);

  assert.equal(names.includes('agent'), false);
  assert.ok(names.length > 0);
});

test('an allow list narrows the child to those tools alone', () => {
  assert.deepEqual(
    childTools('auto-edits', ['grep']).map((tool) => tool.name),
    ['grep'],
  );
});

test('a role is appended to the end of the sub-agent prompt', () => {
  const root = workspace();
  const withRole = subagentPrompt(root, 'auto-edits', 'you only read');
  const without = subagentPrompt(root, 'auto-edits');

  assert.ok(withRole.endsWith('\n\nyou only read'));
  assert.equal(without.endsWith('you only read'), false);
  assert.ok(withRole.startsWith(without));
});

test('an event from the child never reaches the parent host', () => {
  const {host, events} = fakeHost();
  const child = childHost(host);

  child.host.onEvent({type: 'text_delta', text: 'thinking'});
  child.host.onEvent({type: 'tool_start', id: 'call-1', name: 'grep', args: {}});
  child.host.onEvent({type: 'turn_end', usage: {prompt: 1, completion: 2, total: 3}});

  assert.deepEqual(events, []);
  assert.equal(child.events.length, 3);
});

test('a question from the child is asked in the parent, named as the sub-agent', async () => {
  const {host, asked} = fakeHost();
  const child = childHost(host);

  const answer = await child.host.confirm({
    command: 'rm build.log',
    reason: 'deletes build.log',
    suppressible: true,
  });

  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.reason, 'sub-agent: deletes build.log');
  assert.equal(asked[0]!.command, 'rm build.log');
  assert.equal(answer, 'once');
});

test('interrupting the child reports the interruption, not a half answer', async () => {
  const root = workspace();
  const {host, controller} = fakeHost();
  const {choice} = fakeModel(() => {
    controller.abort();
    return streamOf(textChunk('half an answer'), finishChunk('stop'), usageChunk(1, 1));
  });

  const output = await subagent.run(job, context(root, host, choice));

  assert.equal(output.text, INTERRUPTED);
});

test('a run with no model to lend says so instead of throwing', async () => {
  const root = workspace();
  const {host, events, asked} = fakeHost();

  const output = await subagent.run(job, context(root, host));

  assert.match(output.text, /^the sub-agent could not start: /);
  assert.equal(output.usage, undefined);
  assert.deepEqual(events, []);
  assert.deepEqual(asked, []);
});
