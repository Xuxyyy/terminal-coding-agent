import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {z} from 'zod';
import type {ConfirmDecision, ConfirmRequest, Host} from '../../../core/host.js';
import type {Request} from '../../../core/permission/decide.js';
import type {Mode} from '../../../core/permission/mode.js';
import type {Rule, Rules, Tag} from '../../../core/settings.js';
import {judgeMessages} from '../../../core/permission/judge.js';
import {addTask, createSession} from '../../../core/session.js';
import {runTool, type Tool, type ToolContext} from '../../../core/tools/registry.js';

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-judge-')));
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

type FakeJudge = {
  judge: (request: Request, reason: string) => Promise<'allow' | 'ask'>;
  seen: {request: Request; reason: string}[];
};

function judgeThatSays(verdict: 'allow' | 'ask'): FakeJudge {
  const seen: FakeJudge['seen'] = [];
  return {
    seen,
    async judge(request, reason) {
      seen.push({request, reason});
      return verdict;
    },
  };
}

function judgeThatThrows(): FakeJudge {
  const seen: FakeJudge['seen'] = [];
  return {
    seen,
    async judge(request, reason) {
      seen.push({request, reason});
      throw new Error('the judge is broken');
    },
  };
}

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

const ran: string[] = [];

const fakeBash: Tool = {
  name: 'bash',
  description: 'fake',
  schema: z.object({command: z.string()}),
  request(args) {
    return {kind: 'command', command: (args as {command: string}).command};
  },
  async run(args) {
    ran.push((args as {command: string}).command);
    return {text: '[exit 0]\nran'};
  },
};

type Options = {
  host: Host;
  judge?: FakeJudge;
  mode?: Mode;
  rules?: Rules;
  denied?: string[];
};

function context(root: string, options: Options): ToolContext {
  return {
    root,
    host: options.host,
    allowed: new Set<string>(),
    rules: options.rules ?? rules({}),
    mode: options.mode ?? 'auto',
    judge: options.judge?.judge,
    denied: options.denied ?? [],
  };
}

const DESTRUCTIVE = JSON.stringify({command: 'rm build.log'});

test('a judge that allows runs the tool without a confirm box', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('deny');
  const judge = judgeThatSays('allow');

  const output = await runTool([fakeBash], 'bash', DESTRUCTIVE, context(root, {host, judge}));

  assert.equal(asked.length, 0);
  assert.equal(judge.seen.length, 1);
  assert.match(output.text, /ran/);
});

test('a judge that asks reaches the confirm box once', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const judge = judgeThatSays('ask');

  await runTool([fakeBash], 'bash', DESTRUCTIVE, context(root, {host, judge}));

  assert.equal(judge.seen.length, 1);
  assert.equal(asked.length, 1);
});

test('a judge that throws reaches the confirm box once', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const judge = judgeThatThrows();

  await runTool([fakeBash], 'bash', DESTRUCTIVE, context(root, {host, judge}));

  assert.equal(asked.length, 1);
});

test('a judge allow is never remembered for the session', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('session');
  const judge = judgeThatSays('allow');
  const ctx = context(root, {host, judge});

  await runTool([fakeBash], 'bash', DESTRUCTIVE, ctx);

  assert.equal(ctx.allowed.size, 0);
});

test('a deny rule refuses without consulting the judge', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const judge = judgeThatSays('allow');

  const output = await runTool(
    [fakeBash],
    'bash',
    DESTRUCTIVE,
    context(root, {host, judge, rules: rules({deny: ['rm *']})}),
  );

  assert.equal(judge.seen.length, 0);
  assert.equal(asked.length, 0);
  assert.match(output.text, /denied by a rule in settings\.json/);
});

test('an ask rule reaches the human without consulting the judge', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const judge = judgeThatSays('allow');

  await runTool(
    [fakeBash],
    'bash',
    DESTRUCTIVE,
    context(root, {host, judge, rules: rules({ask: ['rm *']})}),
  );

  assert.equal(judge.seen.length, 0);
  assert.equal(asked.length, 1);
});

test('auto-edits never consults the judge', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('once');
  const judge = judgeThatSays('allow');

  await runTool(
    [fakeBash],
    'bash',
    DESTRUCTIVE,
    context(root, {host, judge, mode: 'auto-edits'}),
  );

  assert.equal(judge.seen.length, 0);
  assert.equal(asked.length, 1);
});

test('a human deny is written down for the judge to read', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('deny');
  const judge = judgeThatSays('ask');
  const denied: string[] = [];

  await runTool(
    [fakeBash],
    'bash',
    JSON.stringify({command: 'rm -rf build'}),
    context(root, {host, judge, denied}),
  );

  assert.deepEqual(denied, ['rm -rf build']);
});

test('the judge sees the hardened command, not the raw one', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('deny');
  const judge = judgeThatSays('allow');

  await runTool(
    [fakeBash],
    'bash',
    JSON.stringify({command: 'git log -1 && rm build.log'}),
    context(root, {host, judge}),
  );

  const seen = judge.seen[0]?.request;
  assert.equal(seen?.kind, 'command');
  assert.equal(
    seen?.kind === 'command' ? seen.command : '',
    'git log --no-ext-diff -1 && rm build.log',
  );
});

test('the judge input is rebuilt from the session on every call', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('deny');
  const session = createSession(root, 'system', 1_000);
  session.mode = 'auto';
  addTask(session, 'tidy the build output');

  const built: string[] = [];
  const ctx: ToolContext = {
    root,
    host,
    allowed: new Set<string>(),
    rules: rules({}),
    mode: 'auto',
    denied: session.denied,
    async judge(request, reason) {
      built.push(
        judgeMessages(session.asked, session.messages, request, reason, session.denied)
          .map((message) => String(message.content))
          .join('\n'),
      );
      return 'allow';
    },
  };

  await runTool([fakeBash], 'bash', DESTRUCTIVE, ctx);
  addTask(session, 'and now delete the logs too');
  await runTool([fakeBash], 'bash', DESTRUCTIVE, ctx);

  assert.equal(built.length, 2);
  assert.ok(built[0]!.includes('tidy the build output'));
  assert.ok(!built[0]!.includes('and now delete the logs too'));
  assert.ok(built[1]!.includes('tidy the build output'));
  assert.ok(built[1]!.includes('and now delete the logs too'));
});
