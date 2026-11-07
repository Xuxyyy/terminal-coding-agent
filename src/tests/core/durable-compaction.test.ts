import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {compactionPrompt, compactSession, CompactionSaveError, SUMMARY_PREFIX} from '../../core/compact.js';
import {modelSettings} from '../../core/client.js';
import {runAgent} from '../../core/loop.js';
import {messagesOf} from '../../core/records.js';
import {addTask, createSession, setMeasured} from '../../core/session.js';
import {startSession} from '../../core/store.js';
import {listSubagents, loadSubagent, startSubagent} from '../../core/subagent-store.js';
import {childTools, subagent} from '../../core/tools/subagent.js';
import {fakeHost, fakeModel, fakeStore, finishChunk, statusError, streamOf, textChunk, toolCallChunk, usageChunk} from '../fakes.js';

const SUMMARY = 'The earlier inspection is complete. No requested file changes have been made. ' +
  'The new assignment is still pending and must be checked before reporting completion.';
const NO_USAGE = {prompt: 0, completion: 0, total: 0};

function fixture(t: {after(fn: () => void): void}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-compact-save-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-compact-home-'));
  const parent = startSession(root, home);
  t.after(() => {
    parent.close();
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  });
  return {root, parent};
}

test('failure-heavy compaction keeps the summary active and original failure evidence saved', async (t) => {
  const {root, parent} = fixture(t);
  const session = createSession(root, 'rules', 1_000_000);
  addTask(session, 'Inspect the service state before retrying the failed restart.');
  const failure = '[exit 1]\nRAW_FAILURE_DETAIL '.repeat(1_000) +
    '\nConfiguration changed; service restart failed.\n[execution: uncertain; inspect effects before retrying]';
  for (let index = 0; index < 12; index++) {
    session.messages.push({role: 'assistant', content: null, tool_calls: [{
      id: `failed-${index}`, type: 'function',
      function: {name: 'bash', arguments: JSON.stringify({command: 'update-config && restart-service'})},
    }]});
    session.messages.push({role: 'tool', tool_call_id: `failed-${index}`, content: failure});
  }
  parent.appendStep(session.messages, NO_USAGE);
  const file = path.join(parent.dir, 'session.jsonl');
  const originalRecords = fs.readFileSync(file, 'utf8');
  const summary = 'The configuration was changed, but the service restart failed. The service state remains uncertain. ' +
    'Inspect the service and configuration before retrying; do not assume the failed command had no effects.';
  const model = fakeModel((nth, body) => {
    const messages = (body as {messages: typeof session.messages}).messages;
    if (nth === 1) {
      assert.equal(messages.filter((message) => message.role === 'tool').length, 12);
      assert.ok(messages.some((message) => message.content === failure));
      assert.equal(messages.at(-1)!.content, compactionPrompt());
      assert.match(compactionPrompt(), /Unresolved failures, attempted repairs, and uncertain effects/);
      return streamOf(textChunk(summary), finishChunk('stop'));
    }
    assert.equal(messages.some((message) => message.role === 'tool'), false);
    assert.equal(messages.some((message) => message.role === 'assistant' && message.tool_calls?.length), false);
    assert.ok(messages.some((message) => message.content === SUMMARY_PREFIX + summary));
    assert.doesNotMatch(JSON.stringify(messages), /RAW_FAILURE_DETAIL/);
    return streamOf(textChunk('The uncertain service state still needs inspection.'), finishChunk('stop'));
  });
  setMeasured(session, 900_000);
  const {host, events} = fakeHost();

  await runAgent(session, model.choice, host, [], parent, {durableTools: true, maxSteps: 2});

  assert.equal(model.calls(), 2);
  const compact = events.find((event) => event.type === 'compact_end');
  assert.ok(compact?.type === 'compact_end');
  assert.ok(compact.after < compact.before / 10);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(originalRecords));
  const records = parent.records();
  assert.deepEqual(messagesOf(records), session.messages.slice(1));
  assert.equal(records.filter((record) => record.kind === 'compact').length, 1);
  assert.ok(records.some((record) => record.kind === 'messages' && record.messages.some((message) => message.content === failure)));
});

for (const requireSave of [false, true]) {
  test(`compaction save failure ${requireSave ? 'rejects without replacing context' : 'keeps existing best-effort behavior'}`, async () => {
    const session = createSession('/tmp', 'rules', 1_000_000);
    addTask(session, 'original task');
    session.messages.push({role: 'assistant', content: 'old details'});
    setMeasured(session, 900_000);
    const before = [...session.messages];
    const measuredAt = session.measuredAt;
    const model = fakeModel(() => streamOf(textChunk(SUMMARY), finishChunk('stop')));
    const store = fakeStore({appendCompact() { throw new Error('storage unavailable'); }});
    const operation = compactSession(session, model.choice, fakeHost().host, store, [], {requireSave});
    if (requireSave) {
      await assert.rejects(operation, CompactionSaveError);
      assert.deepEqual(session.messages, before);
      assert.equal(session.lastContextTokens, 900_000);
      assert.equal(session.measuredAt, measuredAt);
    } else {
      assert.ok(await operation);
      assert.equal(session.messages.at(-1)!.content, SUMMARY_PREFIX + SUMMARY);
      assert.equal(session.lastContextTokens, 0);
    }
  });
}

for (const trigger of ['threshold', 'context-recovery'] as const) {
  for (const failure of ['before-record', 'after-record'] as const) {
    test(`durable ${trigger} stops after ${failure} compaction save failure and reloads recorded context`, async (t) => {
      const {root, parent} = fixture(t);
      const session = createSession(root, 'rules', 1_000_000);
      session.mode = 'auto-edits';
      addTask(session, 'inspect the original task');
      session.messages.push({role: 'assistant', content: 'earlier details '.repeat(3_000)});
      addTask(session, 'now write after-compact.txt');
      const summaryRequest = trigger === 'threshold' ? 1 : 2;
      const model = fakeModel((nth) => {
        if (nth < summaryRequest) return Object.assign(statusError(400, 'context length exceeded'), {code: 'context_length_exceeded'});
        if (nth === summaryRequest) return streamOf(textChunk(SUMMARY), finishChunk('stop'), usageChunk(20, 5));
        if (nth === summaryRequest + 1) return streamOf(toolCallChunk('write', 'write_file', JSON.stringify({path: 'after-compact.txt', content: 'must not execute'})), finishChunk('tool_calls'));
        return streamOf(textChunk('done'), finishChunk('stop'));
      });
      const child = startSubagent(parent, {
        workspace: root, description: 'compact and continue', tools: ['write_file'], mode: 'auto-edits', sandbox: 'off',
        rules: {allow: [], ask: [], deny: []}, modelSettings: modelSettings(model.choice),
      });
      child.store.appendStep(session.messages, NO_USAGE);
      if (trigger === 'threshold') setMeasured(session, 900_000);
      const failing = {...child.store, appendCompact(...args: Parameters<typeof child.store.appendCompact>) {
        if (failure === 'after-record') child.store.appendCompact(...args);
        throw new Error('compaction storage unavailable');
      }};
      const {host, events} = fakeHost();
      await runAgent(session, model.choice, host, childTools('auto-edits'), failing, {durableTools: true, maxSteps: 3});
      assert.equal(model.calls(), summaryRequest);
      assert.equal(fs.existsSync(path.join(root, 'after-compact.txt')), false);
      assert.equal(events.some((event) => event.type === 'tool_start'), false);
      assert.ok(events.some((event) => event.type === 'error' && /could not save compacted session/.test(event.message)));
      assert.equal(events.filter((event) => event.type === 'compact_end').length, 1);
      assert.equal(events.filter((event) => event.type === 'turn_end').length, 1);
      const records = child.store.records();
      assert.deepEqual(session.messages.slice(1), messagesOf(records));
      assert.equal(records.filter((record) => record.kind === 'compact').length, failure === 'after-record' ? 1 : 0);
      assert.equal(session.messages.filter((message) => message.content === 'now write after-compact.txt').length, 1);
      assert.equal(session.messages.some((message) => message.content === SUMMARY_PREFIX + SUMMARY), failure === 'after-record');
      const count = records.length;
      child.store.appendStep(session.messages, NO_USAGE);
      assert.equal(child.store.records().length, count);
      child.finish('failed');
    });
  }
}

for (const trigger of ['threshold', 'context-recovery'] as const) {
  test(`a persistent child reports failed when ${trigger} cannot save its compaction`, async (t) => {
    const {root, parent} = fixture(t);
    fs.writeFileSync(path.join(root, 'context.txt'), 'earlier inspection details '.repeat(500));
    const summaryRequest = trigger === 'threshold' ? 2 : 3;
    let blockedLog: string | undefined;
    const model = fakeModel((nth, body) => {
      if (nth === 1) return streamOf(
        toolCallChunk('read', 'read_file', JSON.stringify({path: 'context.txt'})), finishChunk('tool_calls'),
        usageChunk(trigger === 'threshold' ? 900_000 : 10, 2),
      );
      if (nth < summaryRequest) return Object.assign(statusError(400, 'context length exceeded'), {code: 'context_length_exceeded'});
      if (nth === summaryRequest) {
        const messages = (body as {messages: {content: string}[]}).messages;
        assert.equal(messages.at(-1)!.content, compactionPrompt());
        const [meta] = listSubagents(parent);
        assert.ok(meta);
        blockedLog = path.join(parent.dir, 'subagents', `agent-${meta.id}.jsonl`);
        fs.renameSync(blockedLog, `${blockedLog}.before-failure`);
        fs.mkdirSync(blockedLog);
        return streamOf(textChunk(SUMMARY), finishChunk('stop'));
      }
      if (nth === summaryRequest + 1) return streamOf(toolCallChunk('write', 'write_file', JSON.stringify({path: 'after-compact.txt', content: 'must not execute'})), finishChunk('tool_calls'));
      return streamOf(textChunk('done'), finishChunk('stop'));
    });
    const result = await subagent.run({description: 'inspect and write', prompt: 'Inspect context.txt, then write after-compact.txt.', background: false}, {
      root, store: parent, choice: model.choice, host: fakeHost().host, allowed: new Set(),
      rules: {allow: [], ask: [], deny: []}, mode: 'auto-edits', sandbox: 'off',
    });
    assert.ok(blockedLog);
    fs.rmdirSync(blockedLog);
    fs.renameSync(`${blockedLog}.before-failure`, blockedLog);
    assert.equal(model.calls(), summaryRequest);
    assert.equal(fs.existsSync(path.join(root, 'after-compact.txt')), false);
    assert.equal(result.failure, true);
    assert.match(result.text, /status: failed/);
    assert.match(result.text, /could not save compacted session/);
    const [meta] = listSubagents(parent);
    assert.ok(meta);
    assert.equal(meta.status, 'failed');
    const saved = loadSubagent(parent, meta.id);
    assert.ok(saved.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'read'));
    assert.equal(saved.messages.some((message) => message.content === SUMMARY_PREFIX + SUMMARY), false);
  });
}
