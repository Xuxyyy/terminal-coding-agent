import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import type {ConfirmRequest, Host} from '../../../core/host.js';
import {
  approvalKey,
  decide,
  MCP_REASON,
  type Outcome,
  type Request,
} from '../../../core/permission/decide.js';
import {judgeMessages} from '../../../core/permission/judge.js';
import {MODES, type Mode} from '../../../core/permission/mode.js';
import type {Rule, Rules, Tag} from '../../../core/settings.js';
import {runTool, type Tool, type ToolContext} from '../../../core/tools/registry.js';

const ROOT = '/tmp/acc-project';
const UNCLASSIFIED_REASON = 'cannot be classified from its text';

const SEARCH: Request = {kind: 'mcp', server: 'notion', tool: 'search'};
const FETCH: Request = {kind: 'mcp', server: 'notion', tool: 'fetch'};

const TAGGED = /^(bash|edit)\((.*)\)$/;

function ruleOf(text: string): Rule {
  const match = TAGGED.exec(text);
  return match ? {tag: match[1] as Tag, pattern: match[2]} : {tag: 'bash', pattern: text};
}

function rules(some: Partial<Record<keyof Rules, string[]>>): Rules {
  const lists = {allow: [], ask: [], deny: [], ...some};
  return {
    allow: lists.allow.map(ruleOf),
    ask: lists.ask.map(ruleOf),
    deny: lists.deny.map(ruleOf),
  };
}

function outcome(mode: Mode, some?: Partial<Record<keyof Rules, string[]>>): Outcome {
  return decide(SEARCH, ROOT, some ? rules(some) : undefined, mode);
}

test('an mcp call asks below auto and is judged in auto', () => {
  assert.equal(outcome('ask-edits').decision, 'ask');
  assert.equal(outcome('auto-edits').decision, 'ask');
  assert.equal(outcome('auto').decision, 'judge');
});

test('an mcp call is suppressible in every mode', () => {
  for (const mode of MODES) {
    assert.equal(outcome(mode).suppressible, true, mode);
  }
});

test('the reason names the MCP server, not the unclassified fallback', () => {
  for (const mode of MODES) {
    assert.equal(outcome(mode).reason, MCP_REASON, mode);
    assert.notEqual(outcome(mode).reason, UNCLASSIFIED_REASON);
  }
});

test('the approval key is per tool, not per server', () => {
  assert.equal(approvalKey(SEARCH), approvalKey({...SEARCH}));
  assert.notEqual(approvalKey(SEARCH), approvalKey(FETCH));
  assert.match(approvalKey(SEARCH), /notion/);
  assert.match(approvalKey(SEARCH), /search/);
});

test('bash and edit rules do not touch an mcp request', () => {
  const denying = {deny: ['bash(*)', 'edit(*)']};
  assert.equal(outcome('ask-edits', denying).decision, 'ask');
  assert.equal(outcome('auto', denying).decision, 'judge');
  assert.equal(outcome('auto-edits', {allow: ['bash(*)']}).decision, 'ask');
});

test('the judge is told the server and tool, with no undefined', () => {
  const built = judgeMessages({
    asked: ['find the launch notes'],
    messages: [],
    root: ROOT,
    request: SEARCH,
    reason: MCP_REASON,
  });
  const text = built.map((message) => String(message.content)).join('\n');
  assert.match(text, /notion\/search/);
  assert.doesNotMatch(text, /undefined/);
  assert.ok(built.some((message) => message.content === 'find the launch notes'));
});

function mcpTool(server: string, name: string): Tool {
  return {
    name: `mcp__${server}__${name}`,
    description: '',
    schema: z.record(z.unknown()),
    request: () => ({kind: 'mcp', server, tool: name}),
    run: async () => ({text: 'ok'}),
  };
}

function context(host: Host, allowed = new Set<string>()): ToolContext {
  return {
    root: ROOT,
    host,
    allowed,
    rules: rules({}),
    mode: 'auto-edits',
  };
}

function recording(): {host: Host; seen: ConfirmRequest[]} {
  const seen: ConfirmRequest[] = [];
  const host: Host = {
    confirm: async (request) => {
      seen.push(request);
      return 'session';
    },
    onEvent: () => {},
    signal: new AbortController().signal,
  };
  return {host, seen};
}

test('the confirm prompt names the server and the tool', async () => {
  const tool = mcpTool('notion', 'search');
  const {host, seen} = recording();
  await runTool([tool], tool.name, '{}', context(host));
  assert.equal(seen.length, 1);
  assert.match(seen[0].command, /notion\/search/);
  assert.doesNotMatch(seen[0].command, /undefined/);
  assert.equal(seen[0].reason, MCP_REASON);
  assert.equal(seen[0].suppressible, true);
});

test('approving for the session silences that tool but not its neighbour', async () => {
  const search = mcpTool('notion', 'search');
  const fetch = mcpTool('notion', 'fetch');
  const {host, seen} = recording();
  const ctx = context(host);
  await runTool([search, fetch], search.name, '{}', ctx);
  await runTool([search, fetch], search.name, '{}', ctx);
  assert.equal(seen.length, 1);
  await runTool([search, fetch], fetch.name, '{}', ctx);
  assert.equal(seen.length, 2);
});
