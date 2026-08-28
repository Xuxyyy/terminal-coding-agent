import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
} from '../../../core/host.js';
import {
  createHeadlessHost,
  type HeadlessPolicy,
} from '../../../core/headless/host.js';

function request(command: string): ConfirmRequest {
  return {command, reason: `about to run ${command}`, suppressible: true};
}

function headless(policy: HeadlessPolicy) {
  return createHeadlessHost({policy, signal: new AbortController().signal});
}

test('denying answers no and writes the request down', async () => {
  const {host, prompts} = headless('deny');
  const asked = request('rm -rf build');

  const decision = await host.confirm(asked);

  assert.equal(decision, 'deny');
  assert.deepEqual(prompts, [{request: asked, decision: 'deny'}]);
});

test('saying yes approves this once and never for the session', async () => {
  const {host} = headless('yes');

  const decision = await host.confirm(request('npm test'));

  assert.equal(decision, 'once');
  assert.notEqual(decision, 'session');
});

test('the checkpoint to keep going is refused under either policy', async () => {
  for (const policy of ['deny', 'yes'] as const) {
    const {host, prompts} = headless(policy);

    const decision = await host.confirm(request('continue'));

    assert.equal(decision, 'deny', policy);
    assert.deepEqual(
      prompts.map((prompt) => prompt.decision),
      ['deny'],
      policy,
    );
  }
});

test('every request is written down with the answer it got', async () => {
  const {host, prompts} = headless('yes');
  const asked = [request('npm test'), request('continue'), request('ls')];

  const decisions: ConfirmDecision[] = [];
  for (const one of asked) decisions.push(await host.confirm(one));

  assert.deepEqual(decisions, ['once', 'deny', 'once']);
  assert.deepEqual(
    prompts,
    asked.map((one, index) => ({request: one, decision: decisions[index]!})),
  );
});

test('events arrive in the order they were pushed', () => {
  const {host, events} = headless('deny');
  const sent: AgentEvent[] = [
    {type: 'text_delta', text: 'one'},
    {type: 'tool_start', id: 'call-1', name: 'noop', args: {}},
    {type: 'tool_end', id: 'call-1', name: 'noop', result: 'ok', diff: null},
    {type: 'turn_end', usage: {prompt: 10, completion: 2, total: 12}},
  ];

  for (const event of sent) host.onEvent(event);

  assert.deepEqual(events, sent);
});

test('the host carries the signal it was given', () => {
  const controller = new AbortController();

  const {host} = createHeadlessHost({policy: 'yes', signal: controller.signal});

  assert.equal(host.signal, controller.signal);
  assert.equal(host.signal.aborted, false);
  controller.abort();
  assert.equal(host.signal.aborted, true);
});
