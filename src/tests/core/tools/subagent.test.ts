import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import type {AgentDefinition} from '../../../core/agents.js';
import type {ModelChoice} from '../../../core/client.js';
import {INTERRUPTED, type Host} from '../../../core/host.js';
import {subagentPrompt} from '../../../core/prompt.js';
import type {ToolContext} from '../../../core/tools/registry.js';
import {
  childHost,
  childTools,
  makeSubagent,
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

const job = {description: 'read a note', prompt: 'say who owns the note'};

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
  assert.equal(output.text, ANSWER);
  assert.doesNotMatch(output.text, new RegExp(SECRET));
  assert.doesNotMatch(output.text, /notes\.txt/);
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

  assert.equal(output.text, ANSWER);
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

  assert.equal(output.text, ANSWER);
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
        model: 'glm-5.2',
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

  assert.equal(output.text, ANSWER);
  assert.deepEqual(requested, ['glm-5.2']);
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
  assert.deepEqual(empty.bodies[0]!.tools, []);
});

test('unknown types and unavailable tools return repairable errors before a model call', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const choice = recordingChoice();
  const tool = makeSubagent([definition({tools: ['missing_builtin', 'mcp__off__gone']})]);

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
  assert.match(unavailable.text, /mcp__off__gone/);
  assert.equal(choice.calls(), 0);
});

test('a client factory failure is tool text that names the selected agent', async () => {
  const root = workspace();
  const {host} = fakeHost();
  const parent = recordingChoice();
  const tool = makeSubagent([definition({model: 'glm-5.2'})], () => {
    throw new Error('GLM_API_KEY is not set');
  });

  const output = await tool.run(
    {...job, agent: 'explorer'},
    context(root, host, parent.choice),
  );

  assert.match(output.text, /^Error:/);
  assert.match(output.text, /explorer/);
  assert.match(output.text, /GLM_API_KEY/);
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
