import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import type OpenAI from 'openai';
import type {AgentDefinition} from '../../../core/agents.js';
import type {ModelChoice} from '../../../core/client.js';
import {INTERRUPTED, type Host, type AgentEvent} from '../../../core/host.js';
import {runAgent} from '../../../core/loop.js';
import {addTask, createSession} from '../../../core/session.js';
import {startSession, openSession} from '../../../core/store.js';
import {loadSubagent, listSubagents, startSubagent} from '../../../core/subagent-store.js';
import {modelSettings} from '../../../core/client.js';
import {assistantMessage} from '../../../core/messages.js';
import {runTool} from '../../../core/tools/registry.js';
import {subagentPrompt} from '../../../core/prompt.js';
import type {ToolContext} from '../../../core/tools/registry.js';
import {
  childHost,
  childTools,
  makeSubagent,
  report,
  subagent,
} from '../../../core/tools/subagent.js';
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

const job = {description: 'read a note', prompt: 'say who owns the note', background: false};

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'explorer',
    description: 'Explores code without editing',
    prompt: 'Report exact paths.',
    file: '/tmp/explorer.md',
    ...overrides,
  };
}

function recordingChoice(answer = ANSWER): {
  choice: ModelChoice;
  bodies: Record<string, unknown>[];
  calls: () => number;
} {
  const bodies: Record<string, unknown>[] = [];
  let count = 0;
  const create = async (body: Record<string, unknown>): Promise<unknown> => {
    count += 1;
    bodies.push(body);
    return streamOf(textChunk(answer), finishChunk('stop'), usageChunk(2, 1));
  };
  return {
    choice: {
      client: {chat: {completions: {create}}} as unknown as OpenAI,
      model: 'fake-child',
      label: 'Fake child',
      contextWindow: 1_000_000,
    },
    bodies,
    calls: () => count,
  };
}

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
  assert.ok(output.text.endsWith(`\n\n${ANSWER}`));
  assert.doesNotMatch(output.text, new RegExp(SECRET));
  assert.doesNotMatch(output.text, /notes\.txt/);
});

test('omitted or true background requires the main runtime without starting a model', async () => {
  const root = workspace();
  const model = recordingChoice();
  try {
    for (const background of [undefined, true]) {
      const output = await subagent.run({...job, background}, context(root, fakeHost().host, model.choice));
      assert.match(output.text, /background agents require the main agent runtime/);
    }
    assert.equal(model.calls(), 0);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('narration before a tool call is not glued to the final message', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'notes.txt'), `${SECRET}\n`);
  const {host} = fakeHost();
  const {choice} = fakeModel((nth) =>
    nth === 1
      ? streamOf(
          textChunk('Let me read the note first.'),
          toolCallChunk('call-1', 'read_file', JSON.stringify({path: 'notes.txt'})),
          finishChunk('tool_calls'),
          usageChunk(10, 2),
        )
      : streamOf(textChunk(ANSWER), finishChunk('stop'), usageChunk(3, 4)),
  );

  const output = await subagent.run(job, context(root, host, choice));

  assert.ok(output.text.endsWith(`\n\n${ANSWER}`));
});

test('the usage the parent sees is the whole child turn', async () => {
  const root = workspace();
  const {host, modelUsage} = fakeHost();
  const {choice} = readsThenAnswers(root);

  const output = await subagent.run(job, context(root, host, choice));

  assert.deepEqual(output.usage, {prompt: 13, completion: 6, total: 19});
  assert.deepEqual(
    modelUsage.map((usage) => usage.totalTokens),
    [12, 7],
  );
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

test('auto child allowlists cannot restore read or search tools or add recursive agents', () => {
  const offered = childTools('auto', ['grep', 'glob', 'read_file']);
  assert.deepEqual(offered, []);
  assert.deepEqual(childTools('auto').map((tool) => tool.name), ['edit_file', 'write_file', 'bash', 'send_message']);
  const editing = childTools('auto', ['edit_file', 'write_file']);
  assert.deepEqual(editing.map((tool) => tool.name), ['edit_file', 'write_file']);
  assert.ok(editing.every((tool) => tool.description.includes('Prefer this tool')));
  assert.ok(editing.every((tool) => tool.description.includes('/rewind can use its existing backups when available')));
  assert.equal(childTools('auto').some((tool) => tool.name === 'agent'), false);
});

test('children use the parent auto preference unless configured with a stricter mode', async () => {
  const root = workspace();
  const {host} = fakeHost();

  for (const configured of [undefined, 'auto-edits', 'ask-edits'] as const) {
    const child = recordingChoice();
    const tool = makeSubagent([definition({permissionMode: configured})]);
    const ctx = {...context(root, host, child.choice), mode: 'auto' as const};
    const output = await tool.run({...job, agent: 'explorer'}, ctx);
    assert.ok(output.text.endsWith(`\n\n${ANSWER}`));
    const mode = configured ?? 'auto';
    const body = child.bodies[0]!;
    const messages = body.messages as {content: string}[];
    assert.equal(messages[0]!.content, subagentPrompt(root, mode, 'Report exact paths.'));
    assert.doesNotMatch(messages[0]!.content, /Prefer bash|Prefer edit_file/);
    const offered = body.tools as {function: {name: string; description: string}}[];
    assert.deepEqual(offered.map((tool) => tool.function.name), mode === 'auto'
      ? ['edit_file', 'write_file', 'bash', 'send_message']
      : ['read_file', 'grep', 'glob', 'edit_file', 'write_file', 'bash', 'send_message']);
    const shell = offered.find((tool) => tool.function.name === 'bash')!;
    assert.equal(shell.function.description.includes('Use this tool for ordinary file reads, searches, and running commands'), mode === 'auto');
    for (const tool of offered.filter((tool) => tool.function.name === 'edit_file' || tool.function.name === 'write_file')) {
      assert.equal(tool.function.description.includes('Prefer this tool'), mode === 'auto');
      assert.equal(tool.function.description.includes('/rewind can use its existing backups when available'), mode === 'auto');
    }
  }
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

test('child thinking reaches diagnostic logs without becoming a parent message', () => {
  const {host, events} = fakeHost();
  const diagnostics: unknown[] = [];
  host.onDiagnostic = (event) => diagnostics.push(event);
  const child = childHost(host);
  const thinking = {type: 'thinking_delta' as const, text: 'Inspect the file.',
    requestId: 'child-request', agentId: child.host.agentId!, attempt: 1};
  child.host.onEvent(thinking);
  child.host.onEvent({type: 'text_delta', text: 'Child answer.'});
  assert.deepEqual(diagnostics, [thinking]);
  assert.deepEqual(events, []);
  assert.equal(report(child.events).text, 'Child answer.');
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

  assert.ok(output.text.endsWith(`\n\n${INTERRUPTED}`));
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

test('definitions add sorted routing while an omitted type keeps the general child', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const parent = recordingChoice();
  const factoryCalls: (string | undefined)[] = [];
  const tool = makeSubagent(
    [
      definition({name: 'writer', description: 'Writes focused changes'}),
      definition(),
    ],
    (model) => {
      factoryCalls.push(model);
      return recordingChoice().choice;
    },
  );

  const output = await tool.run(job, context(root, host, parent.choice));

  assert.ok(output.text.endsWith(`\n\n${ANSWER}`));
  assert.deepEqual(factoryCalls, []);
  assert.match(tool.description, /explorer: Explores code without editing/);
  assert.match(tool.description, /writer: Writes focused changes/);
  assert.ok(tool.description.indexOf('explorer:') < tool.description.indexOf('writer:'));
  const messages = parent.bodies[0]!.messages as {role: string; content: string}[];
  assert.equal(messages[0]!.content, subagentPrompt(root, 'auto-edits'));
});

test('a named type uses its lazy model, appended prompt, tool order, and stricter mode', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const child = recordingChoice();
  const requested: (string | undefined)[] = [];
  const tool = makeSubagent(
    [
      definition({
        model: 'kimi-k3',
        tools: ['grep', 'read_file'],
        permissionMode: 'ask-edits',
      }),
    ],
    (model) => {
      requested.push(model);
      return child.choice;
    },
  );

  const output = await tool.run(
    {...job, agent: 'explorer'},
    context(root, host, recordingChoice().choice),
  );

  assert.ok(output.text.endsWith(`\n\n${ANSWER}`));
  assert.deepEqual(requested, ['kimi-k3']);
  const body = child.bodies[0]!;
  const messages = body.messages as {role: string; content: string}[];
  assert.equal(messages[0]!.content, subagentPrompt(root, 'ask-edits', 'Report exact paths.'));
  assert.deepEqual(
    (body.tools as {function: {name: string}}[]).map((entry) => entry.function.name),
    ['grep', 'read_file'],
  );
});

test('a named type without a model reuses the exact parent choice', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const parent = recordingChoice();
  let factoryCalled = false;
  const tool = makeSubagent([definition()], () => {
    factoryCalled = true;
    return recordingChoice().choice;
  });

  await tool.run({...job, agent: 'explorer'}, context(root, host, parent.choice));

  assert.equal(parent.calls(), 1);
  assert.equal(factoryCalled, false);
});

test('missing tools inherit every offered tool except agent and an empty list offers none', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const inherited = recordingChoice();
  const empty = recordingChoice();
  const inheritedTool = makeSubagent([definition()]);
  const emptyTool = makeSubagent([definition({tools: []})]);

  await inheritedTool.run({...job, agent: 'explorer'}, context(root, host, inherited.choice));
  await emptyTool.run({...job, agent: 'explorer'}, context(root, host, empty.choice));

  const inheritedNames = (
    inherited.bodies[0]!.tools as {function: {name: string}}[]
  ).map((entry) => entry.function.name);
  assert.ok(inheritedNames.length > 0);
  assert.equal(inheritedNames.includes('agent'), false);
  assert.equal(empty.bodies[0]!.tools, undefined);
});

test('unknown types and unavailable tools return repairable errors before a model call', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const choice = recordingChoice();
  const tool = makeSubagent([definition({tools: ['missing_builtin', 'missing_external']})]);

  const unknown = await tool.run(
    {...job, agent: 'missing'},
    context(root, host, choice.choice),
  );
  const unavailable = await tool.run(
    {...job, agent: 'explorer'},
    context(root, host, choice.choice),
  );

  assert.match(unknown.text, /unknown agent type 'missing'/);
  assert.match(unknown.text, /explorer/);
  assert.match(unavailable.text, /explorer/);
  assert.match(unavailable.text, /missing_builtin/);
  assert.match(unavailable.text, /missing_external/);
  assert.equal(choice.calls(), 0);
});

test('a client factory failure is tool text that names the selected agent', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const parent = recordingChoice();
  const tool = makeSubagent([definition({model: 'kimi-k3'})], () => {
    throw new Error('MOONSHOT_API_KEY is not set');
  });

  const output = await tool.run(
    {...job, agent: 'explorer'},
    context(root, host, parent.choice),
  );

  assert.match(output.text, /^Error:/);
  assert.match(output.text, /explorer/);
  assert.match(output.text, /MOONSHOT_API_KEY/);
  assert.equal(parent.calls(), 0);
});

test('a configured recursive agent tool is unavailable and never reaches the child', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const choice = recordingChoice();
  const tool = makeSubagent([definition({tools: ['agent']})]);

  const output = await tool.run(
    {...job, agent: 'explorer'},
    context(root, host, choice.choice),
  );

  assert.match(output.text, /agent.*unavailable|unavailable.*agent/i);
  assert.equal(choice.calls(), 0);
});

for (const sandbox of ['off', 'on'] as const) {
  test(`subagent inherits Sandbox ${sandbox} in its instructions and tool execution`, async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, '.env'), 'fake-file-secret');
    const {host} = fakeHost();
    const requests: string[] = [];
    const {choice} = fakeModel((nth, body) => {
      requests.push(JSON.stringify(body));
      return nth === 1
        ? streamOf(toolCallChunk('call-1', 'read_file', JSON.stringify({path: '.env'})), finishChunk('tool_calls'))
        : streamOf(textChunk('done'), finishChunk('stop'));
    });
    await subagent.run(job, {...context(root, host, choice), sandbox});
    assert.match(requests[0]!, new RegExp(`Sandbox: ${sandbox === 'on' ? 'On' : 'Off'}`));
    assert.equal(requests[1]!.includes('fake-file-secret'), sandbox === 'off');
    if (sandbox === 'on') assert.match(requests[1]!, /sandbox blocks credential storage/);
    fs.rmSync(root, {recursive: true, force: true});
  });
}


test('named subagents inherit reasoning even when a factory supplies another effort', async () => {
  const root = workspace();
  try {
    const parent = recordingChoice();
    parent.choice.reasoningEffort = 'max';
    const child = recordingChoice();
    child.choice.model = 'deepseek-flash';
    child.choice.reasoningEffort = 'low';
    let passed: unknown;
    const tool = makeSubagent([definition({model: 'deepseek-flash'})], (_id, effort) => {
      passed = effort;
      return child.choice;
    });
    await tool.run({...job, agent: 'explorer'}, context(root, fakeHost().host, parent.choice));
    assert.equal(passed, 'max');
    assert.equal(child.bodies[0]!.reasoning_effort, 'max');
    assert.deepEqual(child.bodies[0]!.thinking, {type: 'enabled'});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

function persistent(t: {after(fn: () => void): void}) {
  const root = workspace();
  const home = workspace();
  const store = startSession(root, home);
  t.after(() => {
    store.close();
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  });
  return {root, home, store};
}

function idOf(text: string): string {
  const id = /^agent_id: (.+)$/m.exec(text)?.[1];
  assert.ok(id);
  return id;
}

test('the real parent loop persists separate child tool history and stable diagnostic identity', async (t) => {
  const {root, store} = persistent(t);
  fs.writeFileSync(path.join(root, 'notes.txt'), SECRET);
  const {host} = fakeHost();
  const diagnostics: AgentEvent[] = [];
  host.onDiagnostic = (event) => diagnostics.push(event);
  const {choice} = fakeModel((nth) => {
    if (nth === 1) return streamOf(toolCallChunk('delegate', 'agent', JSON.stringify(job)), finishChunk('tool_calls'));
    if (nth === 2) return streamOf(toolCallChunk('read', 'read_file', JSON.stringify({path: 'notes.txt'})), finishChunk('tool_calls'), usageChunk(10, 2));
    return streamOf(textChunk(nth === 3 ? ANSWER : 'parent done'), finishChunk('stop'), usageChunk(3, 4));
  });
  const session = createSession(root, 'parent', choice.contextWindow);
  session.mode = 'auto-edits';
  store.appendMessage(addTask(session, 'delegate the note check'));
  await runAgent(session, choice, host, [subagent], store);
  const [meta] = listSubagents(store);
  assert.ok(meta);
  assert.equal(meta.status, 'completed');
  const saved = loadSubagent(store, meta.id);
  assert.ok(JSON.stringify(saved.messages).includes(SECRET));
  assert.ok(!JSON.stringify(store.records()).includes(SECRET));
  assert.ok(JSON.stringify(store.records()).includes(`agent_id: ${meta.id}`));
  assert.deepEqual(diagnostics.filter((event) => event.type === 'model_attempt').map((event) => event.evidence.agentId), [meta.id, meta.id]);
  assert.deepEqual(meta.usage, {prompt: 13, completion: 6, total: 19});
  const file = path.join(store.dir, 'subagents', `agent-${meta.id}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('repeated resume appends to one child history and restart discovers it after parent compaction', async (t) => {
  const {root, home, store} = persistent(t);
  const model = recordingChoice('remembered answer');
  const first = await subagent.run({...job, prompt: 'Remember the codeword violet-cabin.'}, {...context(root, fakeHost().host, model.choice), store});
  const id = idOf(first.text);
  const file = path.join(store.dir, 'subagents', `agent-${id}.jsonl`);
  const original = fs.readFileSync(file, 'utf8');
  await subagent.run({...job, resume: id, prompt: 'Use the earlier codeword.'}, {...context(root, fakeHost().host, model.choice), store});
  assert.match(JSON.stringify(model.bodies[1]!.messages), /violet-cabin/);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(original));
  store.appendCompact({role: 'assistant', content: 'summary with no agent identities'}, 10, [{role: 'assistant', content: 'summary'}]);
  const parentId = store.id;
  store.close();
  const script = `
    import assert from 'node:assert/strict';
    import {openSession} from ${JSON.stringify(new URL('../../../core/store.js', import.meta.url).href)};
    import {subagent} from ${JSON.stringify(new URL('../../../core/tools/subagent.js', import.meta.url).href)};
    import {fakeHost, fakeModel, streamOf, textChunk, finishChunk} from ${JSON.stringify(new URL('../../fakes.js', import.meta.url).href)};
    const {store} = openSession(${JSON.stringify(root)}, ${JSON.stringify(parentId)}, ${JSON.stringify(home)});
    const {host} = fakeHost();
    let sent;
    const {choice} = fakeModel((_n, body) => { sent = body; return streamOf(textChunk('restart done'), finishChunk('stop')); });
    choice.model = 'fake-child';
    const ctx = {root: ${JSON.stringify(root)}, host, allowed: new Set(), rules: {allow: [], ask: [], deny: []}, mode: 'auto-edits', choice, store};
    const listed = JSON.parse((await subagent.run({action: 'list'}, ctx)).text);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agent_id, ${JSON.stringify(id)});
    const result = await subagent.run({resume: listed[0].agent_id, description: 'recall codeword', prompt: 'What was the earlier codeword?', background: false}, ctx);
    assert.match(JSON.stringify(sent.messages), /violet-cabin/);
    assert.equal(sent.messages.filter(m => m.role === 'user').length, 3);
    assert.ok(result.text.includes('restart done'));
    store.close();
  `;
  const restarted = spawnSync(process.execPath, ['--import', new URL('../../offline.js', import.meta.url).pathname, '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10_000});
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(listSubagents(store).length, 1);
  assert.equal(loadSubagent(store, id).messages.filter((m) => m.role === 'user').length, 3);
});

test('a hard-interrupted tool batch keeps saved results and marks only missing outcomes uncertain', async (t) => {
  const {root, store} = persistent(t);
  const model = recordingChoice('inspected without repeating');
  const child = startSubagent(store, {
    workspace: root, description: 'unfinished actions', tools: ['bash'], mode: 'auto-edits', sandbox: 'off',
    rules: {allow: [], ask: [], deny: []}, modelSettings: modelSettings(model.choice),
  });
  child.store.appendMessage({role: 'user', content: 'Do the original job.'});
  child.store.appendStep([
    assistantMessage('', [{id: 'done', name: 'bash', args: '{"command":"printf done"}'}, {id: 'pending', name: 'bash', args: '{"command":"touch repeated.txt"}'}]),
    {role: 'tool', tool_call_id: 'done', content: 'completed action'},
  ], {prompt: 5, completion: 2, total: 7});
  child.store.close();
  const metaFile = path.join(store.dir, 'subagents', `agent-${child.meta.id}.json`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.status = 'running';
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  assert.equal(listSubagents(store)[0]!.status, 'interrupted');
  const result = await subagent.run({...job, resume: meta.id, prompt: 'Inspect the current state and report.'}, {...context(root, fakeHost().host, model.choice), store});
  const messages = model.bodies[0]!.messages as {role: string; tool_call_id?: string; content: string}[];
  assert.equal(messages.filter((m) => m.tool_call_id === 'done').length, 1);
  assert.match(messages.find((m) => m.tool_call_id === 'pending')!.content, /Execution is uncertain/);
  assert.match(JSON.stringify(messages), /previous assignment did not complete/);
  assert.ok(!fs.existsSync(path.join(root, 'repeated.txt')));
  assert.match(result.text, /status: completed/);
  assert.equal(loadSubagent(store, meta.id).messages.filter((m) => m.role === 'tool').length, 2);
});

test('cancellation saves an interrupted child that can receive a new assignment', async (t) => {
  const {root, store} = persistent(t);
  const {host, controller} = fakeHost();
  const cancelled = fakeModel(() => {
    controller.abort();
    return streamOf(textChunk('unfinished'), finishChunk('stop'), usageChunk(2, 1));
  });
  const output = await subagent.run(job, {...context(root, host, cancelled.choice), store});
  const id = idOf(output.text);
  assert.match(output.text, /status: interrupted/);
  assert.equal(loadSubagent(store, id).meta.status, 'interrupted');
  const next = recordingChoice();
  next.choice.model = cancelled.choice.model;
  await subagent.run({...job, resume: id, prompt: 'Continue carefully.'}, {...context(root, fakeHost().host, next.choice), store});
  assert.match(JSON.stringify(next.bodies[0]!.messages), /previous assignment did not complete/);
  assert.equal(loadSubagent(store, id).meta.status, 'completed');
});

test('resume preserves saved role, tools, model effort, and stricter mode after definitions change', async (t) => {
  const {root, store} = persistent(t);
  const original = recordingChoice();
  original.choice.model = 'deepseek-flash';
  original.choice.reasoningEffort = 'max';
  const first = await makeSubagent([definition({tools: ['write_file'], permissionMode: 'ask-edits'})]).run(
    {...job, agent: 'explorer'}, {...context(root, fakeHost().host, original.choice), store},
  );
  const resumed = fakeModel((nth) => nth === 1
    ? streamOf(toolCallChunk('write', 'write_file', JSON.stringify({path: 'blocked.txt', content: 'must ask'})), finishChunk('tool_calls'))
    : streamOf(textChunk('reported refusal'), finishChunk('stop')));
  resumed.choice.model = original.choice.model;
  resumed.choice.reasoningEffort = 'none';
  const {host, asked} = fakeHost();
  host.confirm = async (request) => { asked.push(request); return 'deny'; };
  const bodies: string[] = [];
  const create = resumed.choice.client.chat.completions.create;
  resumed.choice.client = {chat: {completions: {create: async (body: unknown, options: unknown) => {
    bodies.push(JSON.stringify(body)); return create(body as never, options as never);
  }}}} as unknown as OpenAI;
  const reopened = {...context(root, host, resumed.choice), mode: 'auto' as const, store};
  await makeSubagent([]).run({...job, resume: idOf(first.text)}, reopened);
  assert.equal(asked.length, 1);
  assert.ok(!fs.existsSync(path.join(root, 'blocked.txt')));
  assert.match(bodies[0]!, /Report exact paths/);
  assert.match(bodies[0]!, /"reasoning_effort":"max"/);
  assert.deepEqual(JSON.parse(bodies[0]!).tools.map((one: {function: {name: string}}) => one.function.name), ['write_file']);
});

for (const restriction of ['saved-deny', 'current-deny', 'current-mode', 'saved-sandbox', 'current-sandbox'] as const) {
  test(`resume enforces ${restriction} without restoring old approvals`, async (t) => {
    const {root, store} = persistent(t);
    const model = recordingChoice();
    const {host} = fakeHost();
    const ctx = {...context(root, host, model.choice), store, sandbox: restriction === 'saved-sandbox' ? 'on' as const : 'off' as const};
    if (restriction === 'saved-deny') ctx.rules.deny.push({tag: 'edit', pattern: 'blocked.txt'});
    const first = await subagent.run(job, ctx);
    const id = idOf(first.text);
    const next = fakeModel((nth) => nth === 1
      ? streamOf(toolCallChunk('action', restriction.includes('sandbox') ? 'read_file' : 'write_file', JSON.stringify({path: restriction.includes('sandbox') ? '.env' : 'blocked.txt', content: 'no'})), finishChunk('tool_calls'))
      : streamOf(textChunk('done'), finishChunk('stop')));
    next.choice.model = model.choice.model;
    fs.writeFileSync(path.join(root, '.env'), 'test-placeholder-secret');
    const resumedHost = fakeHost();
    resumedHost.host.confirm = async (request) => { resumedHost.asked.push(request); return 'deny'; };
    const resumedCtx = {...context(root, resumedHost.host, next.choice), store,
      sandbox: restriction === 'current-sandbox' ? 'on' as const : 'off' as const,
      mode: restriction === 'current-mode' ? 'ask-edits' as const : 'auto-edits' as const};
    if (restriction === 'current-deny') resumedCtx.rules.deny.push({tag: 'edit', pattern: 'blocked.txt'});
    await subagent.run({...job, resume: id}, resumedCtx);
    assert.ok(!fs.existsSync(path.join(root, 'blocked.txt')));
    const saved = JSON.stringify(loadSubagent(store, id).messages);
    if (restriction.includes('sandbox')) assert.match(saved, /sandbox blocks credential storage/);
    else if (restriction.includes('deny')) assert.match(saved, /denied by a rule/);
    else assert.equal(resumedHost.asked.length, 1);
  });
}

test('IDs are parent-scoped and invalid resume or list calls do not invoke a model', async (t) => {
  const {root, store} = persistent(t);
  const otherHome = workspace();
  const other = startSession(root, otherHome);
  t.after(() => { other.close(); fs.rmSync(otherHome, {recursive: true, force: true}); });
  const model = recordingChoice();
  const ctx = {...context(root, fakeHost().host, model.choice), store};
  const first = await subagent.run(job, ctx);
  for (const args of [{...job, resume: idOf(first.text)}, {...job, resume: '../session'}, {action: 'list', prompt: 'do work'}]) {
    const result = await runTool([subagent], 'agent', JSON.stringify(args), {...ctx, store: other});
    assert.match(result.text, /^Error:/);
  }
  assert.equal(model.calls(), 1);
});


test('a durable child records a call before permission and counts cancelled tool usage once', async (t) => {
  const {root, store} = persistent(t);
  const {host, controller} = fakeHost();
  let observed = false;
  host.confirm = async () => {
    const [meta] = listSubagents(store);
    assert.ok(meta);
    const saved = loadSubagent(store, meta.id);
    assert.match(JSON.stringify(saved.messages), /pending-write/);
    assert.equal(saved.messages.some((m) => m.role === 'tool'), false);
    observed = true;
    controller.abort();
    return 'once';
  };
  const {choice} = fakeModel(() => streamOf(
    toolCallChunk('pending-write', 'write_file', JSON.stringify({path: 'cancelled.txt', content: 'never written'})),
    finishChunk('tool_calls'), usageChunk(5, 2),
  ));
  const result = await subagent.run(job, {...context(root, host, choice), mode: 'ask-edits', store});
  assert.equal(observed, true);
  assert.equal(fs.existsSync(path.join(root, 'cancelled.txt')), false);
  assert.deepEqual(loadSubagent(store, idOf(result.text)).meta.usage, {prompt: 5, completion: 2, total: 7});
  assert.equal(loadSubagent(store, idOf(result.text)).messages.filter((m) => m.role === 'tool').length, 1);
});

test('a torn transcript tail keeps later resume records readable across more than one reopen', async (t) => {
  const {root, store} = persistent(t);
  const model = recordingChoice();
  const ctx = {...context(root, fakeHost().host, model.choice), store};
  const first = await subagent.run({...job, prompt: 'Keep original context.'}, ctx);
  const id = idOf(first.text);
  const file = path.join(store.dir, 'subagents', `agent-${id}.jsonl`);
  fs.appendFileSync(file, '{"kind":"messages","mess');
  await subagent.run({...job, resume: id, prompt: 'First recovery.'}, ctx);
  await subagent.run({...job, resume: id, prompt: 'Second recovery.'}, ctx);
  const saved = JSON.stringify(loadSubagent(store, id).messages);
  assert.match(saved, /Keep original context/);
  assert.match(saved, /First recovery/);
  assert.match(saved, /Second recovery/);
});

test('a failed transcript write stops a durable child before the tool can execute', async (t) => {
  const {root, store} = persistent(t);
  const session = createSession(root, 'child', 1_000_000);
  addTask(session, 'write a file');
  const {host} = fakeHost();
  const model = fakeModel(() => streamOf(toolCallChunk('write', 'write_file', JSON.stringify({path: 'not-written.txt', content: 'no'})), finishChunk('tool_calls')));
  const failing = {...store, appendStep() { throw new Error('disk unavailable'); }};
  await assert.rejects(runAgent(session, model.choice, host, childTools('auto-edits'), failing, {durableTools: true}), /disk unavailable/);
  assert.equal(fs.existsSync(path.join(root, 'not-written.txt')), false);
});


test('a named child without a parent model keeps the client factory reasoning default', async () => {
  const root = workspace();
  try {
    const model = recordingChoice();
    model.choice.model = 'deepseek-flash';
    model.choice.reasoningEffort = 'max';
    const tool = makeSubagent([definition({model: 'deepseek-flash'})], () => model.choice);
    await tool.run({...job, agent: 'explorer'}, context(root, fakeHost().host));
    assert.equal(model.bodies[0]!.reasoning_effort, 'max');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
