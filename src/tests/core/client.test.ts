import assert from 'node:assert/strict';
import test from 'node:test';
import {StreamFailure, streamStep} from '../../core/client.js';
import {
  connectionError,
  fakeHost,
  fakeModel,
  finishChunk,
  statusError,
  streamOf,
  textChunk,
  toolCallChunk,
  usageChunk,
} from '../fakes.js';
import type {AgentEvent} from '../../core/host.js';

const fast = {sleep: async () => {}};

function texts(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'text_delta' ? [event.text] : [],
  );
}

async function failureFrom(promise: Promise<unknown>): Promise<StreamFailure> {
  const result = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(result instanceof StreamFailure)) {
    assert.fail(`expected a StreamFailure, got ${String(result)}`);
  }
  return result;
}

test('a turn collects the text, the tool calls and the usage', async () => {
  const {choice, calls} = fakeModel(() =>
    streamOf(
      textChunk('look'),
      textChunk('ing'),
      toolCallChunk('c1', 'read_file', '{"path":'),
      toolCallChunk('', '', '"a.js"}'),
      finishChunk('tool_calls'),
      usageChunk(120, 30),
    ),
  );
  const {host, events} = fakeHost();

  const turn = await streamStep(choice, [], [], host, fast);

  assert.equal(turn.content, 'looking');
  assert.equal(turn.finishReason, 'tool_calls');
  assert.deepEqual(turn.toolCalls, [
    {id: 'c1', name: 'read_file', args: '{"path":"a.js"}'},
  ]);
  assert.deepEqual(turn.usage, {prompt: 120, completion: 30, total: 150});
  assert.equal(calls(), 1);
  assert.deepEqual(texts(events), ['look', 'ing']);
});

test('a dropped connection before any output is retried', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn < 3
      ? connectionError()
      : streamOf(textChunk('hi'), finishChunk('stop'), usageChunk(10, 2)),
  );
  const {host, events} = fakeHost();

  const turn = await streamStep(choice, [], [], host, fast);

  assert.equal(turn.content, 'hi');
  assert.equal(calls(), 3);
  assert.deepEqual(texts(events), ['hi']);
});

test('a stream that dies before its first chunk is retried', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1
      ? streamOf(connectionError())
      : streamOf(textChunk('hi'), finishChunk('stop')),
  );
  const {host, events} = fakeHost();

  const turn = await streamStep(choice, [], [], host, fast);

  assert.equal(turn.content, 'hi');
  assert.equal(calls(), 2);
  assert.deepEqual(texts(events), ['hi']);
});

test('a dropped connection after output is not retried', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1
      ? streamOf(textChunk('half'), connectionError())
      : streamOf(textChunk('whole'), finishChunk('stop')),
  );
  const {host, events} = fakeHost();

  const failure = await failureFrom(streamStep(choice, [], [], host, fast));

  assert.equal(failure.partial.content, 'half');
  assert.equal(calls(), 1);
  assert.deepEqual(texts(events), ['half']);
});

test('a tool call that has started counts as output', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1
      ? streamOf(toolCallChunk('c1', 'read_file', '{"path":'), connectionError())
      : streamOf(textChunk('whole'), finishChunk('stop')),
  );
  const {host} = fakeHost();

  const failure = await failureFrom(streamStep(choice, [], [], host, fast));

  assert.equal(calls(), 1);
  assert.deepEqual(failure.partial.toolCalls, [
    {id: 'c1', name: 'read_file', args: '{"path":'},
  ]);
});

test('a bad request is not retried', async () => {
  const {choice, calls} = fakeModel((turn) =>
    turn === 1
      ? statusError(400)
      : streamOf(textChunk('never'), finishChunk('stop')),
  );
  const {host} = fakeHost();

  await assert.rejects(streamStep(choice, [], [], host, fast), /status 400/);
  assert.equal(calls(), 1);
});
