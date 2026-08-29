import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import {
  INTERRUPTED,
  type ConfirmDecision,
  type ConfirmRequest,
  type Host,
} from '../../core/host.js';
import {
  connectedTools,
  connectServers,
  disconnectServers,
  serverStatus,
  CONNECT_TIMEOUT,
  type ServerStatus,
} from '../../core/mcp/connect.js';
import type {StdioServer} from '../../core/settings.js';
import {toolsFor} from '../../core/tools/index.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';

const FIXTURE = path.join(
  import.meta.dirname,
  '../../../src/tests/fixtures/echo-server.js',
);

const MANY = path.join(
  import.meta.dirname,
  '../../../src/tests/fixtures/many-tools-server.js',
);

const HANGING = path.join(
  import.meta.dirname,
  '../../../src/tests/fixtures/hanging-server.js',
);

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

function server(fields: Partial<StdioServer> & {command: string}): StdioServer {
  return {args: [], env: {}, enabled: true, tools: null, ...fields};
}

function echoServer(env: Record<string, string> = {}): StdioServer {
  return server({command: process.execPath, args: [FIXTURE], env});
}

function manyServer(tools: string[] | null = null): StdioServer {
  return server({command: process.execPath, args: [MANY], tools});
}

function hangingServer(): StdioServer {
  return server({command: process.execPath, args: [HANGING]});
}

function interruptibleSession(...answers: ConfirmDecision[]) {
  const control = new AbortController();
  const {host, asked} = hostThatAnswers(...answers);
  const ctx = context(workspace(), {...host, signal: control.signal});
  return {ctx, asked, control};
}

function statusOf(label: string): ServerStatus {
  const found = serverStatus().find((status) => status.label === label);
  assert.ok(found, `no status for ${label}`);
  return found;
}

async function connect(
  t: TestContext,
  servers: Record<string, StdioServer>,
  timeout?: number,
): Promise<void> {
  t.after(() => disconnectServers());
  await connectServers(servers, timeout);
}

test('the echo server fixture sits where the compiled test looks for it', () => {
  assert.equal(fs.existsSync(FIXTURE), true, `no fixture at ${FIXTURE}`);
});

test('a server that starts is ready with the tools it listed', async (t) => {
  await connect(t, {echo: echoServer()});

  assert.deepEqual(serverStatus(), [
    {
      label: 'echo',
      state: 'ready',
      tools: ['echo'],
      listed: 1,
      unmatched: [],
      error: null,
    },
  ]);
  assert.deepEqual(
    connectedTools().map((tool) => tool.name),
    ['mcp__echo__echo'],
  );
});

test('a connected tool runs over stdio and returns what the server echoed', async (t) => {
  await connect(t, {echo: echoServer()});
  const {ctx, asked} = session('once');

  const output = await runTool(
    connectedTools(),
    'mcp__echo__echo',
    JSON.stringify({text: 'hello'}),
    ctx,
  );

  assert.equal(asked.length, 1);
  assert.equal(output.text, 'echo: hello');
});

test('a command that does not exist fails without rejecting the connect', async (t) => {
  await connect(t, {broken: server({command: '/no/such/binary'})});
  const [status] = serverStatus();

  assert.equal(status.label, 'broken');
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.tools, []);
  assert.equal(status.listed, 0);
  assert.deepEqual(status.unmatched, []);
  assert.notEqual(status.error, null);
  assert.deepEqual(connectedTools(), []);
});

test('one server failing leaves the working server its tools', async (t) => {
  await connect(t, {
    echo: echoServer(),
    broken: server({command: '/no/such/binary'}),
  });

  assert.deepEqual(
    serverStatus().map((status) => [status.label, status.state]),
    [
      ['echo', 'ready'],
      ['broken', 'failed'],
    ],
  );
  assert.deepEqual(
    connectedTools().map((tool) => tool.name),
    ['mcp__echo__echo'],
  );
});

test('the default connect timeout leaves room for a cold npx download', () => {
  assert.equal(CONNECT_TIMEOUT, 15_000);
});

test(
  'a server slower than the connect timeout fails and does not hold up the others',
  {timeout: 60_000},
  async (t) => {
      await connect(
        t,
        {
          slow: echoServer({ECHO_SLEEP_MS: '5000'}),
          echo: echoServer(),
        },
        400,
      );

      assert.deepEqual(
        serverStatus().map((status) => [status.label, status.state, status.listed]),
        [
          ['slow', 'failed', 0],
          ['echo', 'ready', 1],
        ],
      );
      assert.match(serverStatus()[0].error ?? '', /slow did not answer within 400ms/);
      assert.deepEqual(
        connectedTools().map((tool) => tool.name),
        ['mcp__echo__echo'],
      );
    },
  );

test('with no server configured the model is offered the built-ins alone', async (t) => {
  await connect(t, {});

  assert.deepEqual(
    toolsFor('auto-edits').map((tool) => tool.name),
    ['read_file', 'grep', 'edit_file', 'write_file', 'bash'],
  );
});

test('with no tools key every listed tool is published', async (t) => {
  await connect(t, {many: manyServer()});

  assert.deepEqual(statusOf('many').tools, [
    'list_issues',
    'list_prs',
    'get_file',
    'search_code',
    'create_issue',
  ]);
  assert.equal(statusOf('many').listed, 5);
  assert.equal(connectedTools().length, 5);
});

test(
  'an allowlist publishes only what it matches and still counts what was listed',
  async (t) => {
    await connect(t, {many: manyServer(['list_*', 'get_file'])});

    assert.deepEqual(statusOf('many').tools, ['list_issues', 'list_prs', 'get_file']);
    assert.equal(statusOf('many').listed, 5);
    assert.deepEqual(statusOf('many').unmatched, []);
    assert.deepEqual(
      connectedTools().map((tool) => tool.name),
      ['mcp__many__list_issues', 'mcp__many__list_prs', 'mcp__many__get_file'],
    );
  },
);

test(
  'a pattern that matches nothing publishes nothing and is reported as unmatched',
  async (t) => {
    await connect(t, {many: manyServer(['nope_*'])});

    assert.equal(statusOf('many').state, 'ready');
    assert.deepEqual(statusOf('many').tools, []);
    assert.equal(statusOf('many').listed, 5);
    assert.deepEqual(statusOf('many').unmatched, ['nope_*']);
    assert.deepEqual(connectedTools(), []);
  },
);

test('an empty allowlist publishes nothing from that server', async (t) => {
  await connect(t, {many: manyServer([])});

  assert.equal(statusOf('many').state, 'ready');
  assert.deepEqual(statusOf('many').tools, []);
  assert.equal(statusOf('many').listed, 5);
  assert.deepEqual(statusOf('many').unmatched, []);
  assert.deepEqual(connectedTools(), []);
});

test('a disabled server is never spawned, however broken its command', async (t) => {
  await connect(t, {
    off: server({command: 'definitely-not-a-real-binary', enabled: false}),
  });

  assert.deepEqual(serverStatus(), [
    {label: 'off', state: 'disabled', tools: [], listed: 0, unmatched: [], error: null},
  ]);
  assert.deepEqual(connectedTools(), []);
});

test('a disabled server beside a ready one leaves the ready one its tools', async (t) => {
  await connect(t, {
    off: server({command: 'definitely-not-a-real-binary', enabled: false}),
    echo: echoServer(),
  });

  assert.deepEqual(
    serverStatus().map((status) => [status.label, status.state]),
    [
      ['off', 'disabled'],
      ['echo', 'ready'],
    ],
  );
  assert.deepEqual(
    connectedTools().map((tool) => tool.name),
    ['mcp__echo__echo'],
  );
});

test('disconnecting drops every tool and every status', async () => {
  await connectServers({echo: echoServer()});
  assert.equal(connectedTools().length, 1);

  await disconnectServers();

  assert.deepEqual(connectedTools(), []);
  assert.deepEqual(serverStatus(), []);
  assert.deepEqual(
    toolsFor('auto-edits').map((tool) => tool.name),
    ['read_file', 'grep', 'edit_file', 'write_file', 'bash'],
  );
});

test('the hanging server fixture sits where the compiled test looks for it', () => {
  assert.equal(fs.existsSync(HANGING), true, `no fixture at ${HANGING}`);
});

test(
  'a call the server never answers rejects when the signal aborts',
  {timeout: 30_000},
  async (t) => {
    await connect(t, {hang: hangingServer()});
    const {ctx, control} = interruptibleSession('once');
    const [tool] = connectedTools();
    const timer = setTimeout(() => control.abort(), 100);
    t.after(() => clearTimeout(timer));
    const started = Date.now();

    await assert.rejects(() => tool.run({text: 'hello'}, ctx));

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `the call waited ${elapsed}ms`);
  },
);

test(
  'a hung call interrupted mid-flight reads back as interrupted, not as an error',
  {timeout: 30_000},
  async (t) => {
    await connect(t, {hang: hangingServer()});
    const {ctx, asked, control} = interruptibleSession('once');
    const timer = setTimeout(() => control.abort(), 100);
    t.after(() => clearTimeout(timer));
    const started = Date.now();

    const output = await runTool(
      connectedTools(),
      'mcp__hang__hang',
      JSON.stringify({text: 'hello'}),
      ctx,
    );

    const elapsed = Date.now() - started;
    assert.equal(asked.length, 1);
    assert.equal(output.text, INTERRUPTED);
    assert.ok(elapsed < 5_000, `the call waited ${elapsed}ms`);
  },
);
