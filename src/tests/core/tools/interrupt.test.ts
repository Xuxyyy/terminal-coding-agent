import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {z} from 'zod';
import {
  INTERRUPTED,
  type ConfirmDecision,
  type ConfirmRequest,
  type Host,
} from '../../../core/host.js';
import type {Request} from '../../../core/permission/decide.js';
import type {Mode} from '../../../core/permission/mode.js';
import {runTool, type Judge, type Tool, type ToolContext} from '../../../core/tools/registry.js';

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-interrupt-')));
}

type FakeHost = {
  host: Host;
  controller: AbortController;
  asked: ConfirmRequest[];
};

function hostThatAnswers(
  answer: ConfirmDecision,
  onConfirm?: (controller: AbortController) => void,
): FakeHost {
  const controller = new AbortController();
  const asked: ConfirmRequest[] = [];
  const host: Host = {
    signal: controller.signal,
    onEvent() {},
    async confirm(request) {
      asked.push(request);
      onConfirm?.(controller);
      return answer;
    },
  };
  return {host, controller, asked};
}

type FakeJudge = {judge: Judge; seen: Request[]};

function judgeThatSays(
  verdict: 'allow' | 'ask',
  onJudge?: () => void,
): FakeJudge {
  const seen: Request[] = [];
  return {
    seen,
    async judge(request) {
      seen.push(request);
      onJudge?.();
      return verdict;
    },
  };
}

function recordingBash() {
  const ran: string[] = [];
  const tool: Tool = {
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
  return {tool, ran};
}

function throwingTool(error: () => Error): Tool {
  return {
    name: 'bash',
    description: 'fake',
    schema: z.object({command: z.string()}),
    async run() {
      throw error();
    },
  };
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

type Options = {host: Host; judge?: FakeJudge; mode?: Mode; denied?: string[]};

function context(root: string, options: Options): ToolContext {
  return {
    root,
    host: options.host,
    allowed: new Set<string>(),
    rules: {allow: [], ask: [], deny: []},
    mode: options.mode ?? 'auto-edits',
    judge: options.judge?.judge,
    denied: options.denied ?? [],
  };
}

const DESTRUCTIVE = JSON.stringify({command: 'rm build.log'});

test('a signal already aborted neither prompts nor runs the tool', async () => {
  const root = workspace();
  const {host, controller, asked} = hostThatAnswers('once');
  const {tool, ran} = recordingBash();
  controller.abort();

  const output = await runTool([tool], 'bash', DESTRUCTIVE, context(root, {host}));

  assert.equal(output.text, INTERRUPTED);
  assert.deepEqual(asked, []);
  assert.deepEqual(ran, []);
});

test('a prompt interrupted while it is open is not a denial', async () => {
  const root = workspace();
  const {host, asked} = hostThatAnswers('deny', (controller) => controller.abort());
  const {tool, ran} = recordingBash();
  const denied: string[] = [];

  const output = await runTool([tool], 'bash', DESTRUCTIVE, context(root, {host, denied}));

  assert.equal(output.text, INTERRUPTED);
  assert.deepEqual(denied, []);
  assert.equal(asked.length, 1);
  assert.deepEqual(ran, []);
});

test('a signal aborted while the judge thinks never opens a prompt', async () => {
  const root = workspace();
  const {host, controller, asked} = hostThatAnswers('once');
  const judge = judgeThatSays('ask', () => controller.abort());
  const {tool, ran} = recordingBash();

  const output = await runTool(
    [tool],
    'bash',
    DESTRUCTIVE,
    context(root, {host, judge, mode: 'auto'}),
  );

  assert.equal(output.text, INTERRUPTED);
  assert.equal(judge.seen.length, 1);
  assert.deepEqual(asked, []);
  assert.deepEqual(ran, []);
});

test('a tool that throws after the signal aborts reports the interrupt, not the error', async () => {
  const root = workspace();
  const {host, controller} = hostThatAnswers('once');
  const tool = throwingTool(() => {
    controller.abort();
    return abortError();
  });

  const output = await runTool([tool], 'bash', DESTRUCTIVE, context(root, {host}));

  assert.equal(output.text, INTERRUPTED);
});

test('a tool that throws with the signal untouched still reports the error', async () => {
  const root = workspace();
  const {host} = hostThatAnswers('once');
  const tool = throwingTool(() => new Error('the disk is full'));

  const output = await runTool([tool], 'bash', DESTRUCTIVE, context(root, {host}));

  assert.equal(output.text, 'Error: the disk is full');
});
