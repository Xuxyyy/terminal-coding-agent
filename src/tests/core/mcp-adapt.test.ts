import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type {ConfirmDecision, ConfirmRequest, Host} from '../../core/host.js';
import {
  adaptTool,
  NO_OUTPUT,
  type CallResult,
  type ContentBlock,
  type RemoteTool,
} from '../../core/mcp/adapt.js';
import {tools as builtins} from '../../core/tools/index.js';
import {runTool, toolDefinitions, type ToolContext} from '../../core/tools/registry.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-'));
}

function hostThatAnswers(...answers: ConfirmDecision[]) {
  const asked: ConfirmRequest[] = [];
  const host: Host = {
    signal: new AbortController().signal,
    onEvent() {},
    async confirm(request) {
      asked.push(request);
      return answers[asked.length - 1] ?? answers[answers.length - 1] ?? 'once';
    },
  };
  return {host, asked};
}

function context(root: string, host: Host): ToolContext {
  return {
    root,
    host,
    allowed: new Set<string>(),
    rules: {allow: [], ask: [], deny: []},
    mode: 'auto-edits',
  };
}

function session(...answers: ConfirmDecision[]) {
  const {host, asked} = hostThatAnswers(...answers);
  return {ctx: context(workspace(), host), asked};
}

const SEARCH: RemoteTool = {
  name: 'search',
  description: 'search a workspace',
  inputSchema: {
    type: 'object',
    properties: {query: {type: 'string', description: 'what to look for'}},
    required: ['query'],
    additionalProperties: false,
  },
};

function returning(result: CallResult) {
  const calls: Array<{name: string; args: unknown}> = [];
  const tool = adaptTool('notion', SEARCH, async (name, args) => {
    calls.push({name, args});
    return result;
  });
  return {tool, calls};
}

function texted(content: ContentBlock[]): Promise<string> {
  const {ctx} = session('once');
  const {tool} = returning({content});
  return tool.run({}, ctx).then((output) => output.text);
}

test('the adapted name is namespaced by the server label', () => {
  const tool = adaptTool('notion', SEARCH, async () => ({}));

  assert.equal(tool.name, 'mcp__notion__search');
});

test('a remote tool named like a built-in does not collide with it', () => {
  const tool = adaptTool('files', {name: 'read_file'}, async () => ({}));

  assert.equal(tool.name, 'mcp__files__read_file');
  assert.equal(
    builtins.some((builtin) => builtin.name === tool.name),
    false,
  );
  assert.equal(
    builtins.some((builtin) => builtin.name === 'read_file'),
    true,
  );
});

test('the remote input schema is carried through untouched', () => {
  const tool = adaptTool('notion', SEARCH, async () => ({}));
  const [definition] = toolDefinitions([tool]);

  assert.deepEqual(tool.parameters, SEARCH.inputSchema);
  assert.deepEqual(definition.function.parameters, SEARCH.inputSchema);
});

test('the permission request names the server and the remote tool', () => {
  const tool = adaptTool('notion', SEARCH, async () => ({}));

  assert.deepEqual(tool.request?.({query: 'x'}), {
    kind: 'mcp',
    server: 'notion',
    tool: 'search',
  });
});

test('the remote tool is called by its own name, not the namespaced one', async () => {
  const {ctx} = session('once');
  const {tool, calls} = returning({content: [{type: 'text', text: 'ok'}]});

  await tool.run({query: 'x'}, ctx);

  assert.deepEqual(calls, [{name: 'search', args: {query: 'x'}}]);
});

test('several text blocks join with a newline', async () => {
  const text = await texted([
    {type: 'text', text: 'first'},
    {type: 'text', text: 'second'},
    {type: 'text', text: 'third'},
  ]);

  assert.equal(text, 'first\nsecond\nthird');
});

test('a block that is not text is dropped', async () => {
  const text = await texted([
    {type: 'text', text: 'before'},
    {type: 'image', data: 'iVBORw0KGgo='} as ContentBlock,
    {type: 'text', text: 'after'},
  ]);

  assert.equal(text, 'before\nafter');
});

test('content with nothing readable in it reads as no output', async () => {
  assert.equal(await texted([]), NO_OUTPUT);
  assert.equal(NO_OUTPUT, '(no output)');
});

test('an error result throws with the text the server sent', async () => {
  const {ctx} = session('once');
  const {tool} = returning({
    content: [{type: 'text', text: 'the page was not found'}],
    isError: true,
  });

  await assert.rejects(tool.run({}, ctx), /the page was not found/);
});

test('an error result reaches the model as a tool error, not a crash', async () => {
  const {ctx, asked} = session('once');
  const {tool} = returning({
    content: [{type: 'text', text: 'the page was not found'}],
    isError: true,
  });

  const output = await runTool([tool], tool.name, '{}', ctx);

  assert.equal(asked.length, 1);
  assert.match(output.text, /^Error: /);
  assert.match(output.text, /the page was not found/);
});

test('a remote tool with no description gets an empty one', () => {
  const tool = adaptTool('files', {name: 'list'}, async () => ({}));

  assert.equal(tool.description, '');
});
