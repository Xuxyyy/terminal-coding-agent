import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, {type TestContext} from 'node:test';
import type {ConfirmDecision, ConfirmRequest, Host} from '../../core/host.js';
import {
  connectedTools,
  connectServers,
  disconnectServers,
  serverStatus,
  CONNECT_TIMEOUT,
} from '../../core/mcp/connect.js';
import type {StdioServer} from '../../core/settings.js';
import {toolsFor} from '../../core/tools/index.js';
import {runTool, type ToolContext} from '../../core/tools/registry.js';

const FIXTURE = path.join(
  import.meta.dirname,
  '../../../src/tests/fixtures/echo-server.js',
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
    {label: 'echo', state: 'ready', tools: 1, error: null},
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
  assert.equal(status.tools, 0);
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
      serverStatus().map((status) => [status.label, status.state, status.tools]),
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
