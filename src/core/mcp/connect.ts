import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {serversOf, type StdioServer} from '../settings.js';
import type {Tool} from '../tools/registry.js';
import {adaptTool, type CallResult, type RemoteTool} from './adapt.js';

export const CONNECT_TIMEOUT = 15_000;

export type ServerStatus = {
  label: string;
  state: 'ready' | 'failed';
  tools: number;
  error: string | null;
};

type Connection = {
  status: ServerStatus;
  tools: Tool[];
  close: () => Promise<void>;
};

let connections: Connection[] = [];

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === '' ? 'the server could not be started' : text;
}

async function withTimeout<T>(
  work: Promise<T>,
  label: string,
  timeout: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} did not answer within ${timeout}ms`));
    }, timeout);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectOne(
  label: string,
  server: StdioServer,
  timeout: number,
): Promise<Connection> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: {...getDefaultEnvironment(), ...server.env},
    stderr: 'ignore',
  });
  const client = new Client({name: 'acc', version: '0.1.0'});
  const close = async (): Promise<void> => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };
  try {
    const listed = await withTimeout(
      client.connect(transport).then(() => client.listTools()),
      label,
      timeout,
      () => void close(),
    );
    const call = async (name: string, args: unknown): Promise<CallResult> =>
      (await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      })) as CallResult;
    const tools = (listed.tools as RemoteTool[]).map((remote) =>
      adaptTool(label, remote, call),
    );
    return {
      status: {label, state: 'ready', tools: tools.length, error: null},
      tools,
      close,
    };
  } catch (error) {
    await close();
    return {
      status: {label, state: 'failed', tools: 0, error: reason(error)},
      tools: [],
      close: async () => {},
    };
  }
}

export async function connectServers(
  servers: Record<string, StdioServer> = serversOf(),
  timeout: number = CONNECT_TIMEOUT,
): Promise<void> {
  await disconnectServers();
  connections = await Promise.all(
    Object.entries(servers).map(([label, server]) =>
      connectOne(label, server, timeout),
    ),
  );
}

export function connectedTools(): Tool[] {
  return connections.flatMap((connection) => connection.tools);
}

export function serverStatus(): ServerStatus[] {
  return connections.map((connection) => connection.status);
}

export async function disconnectServers(): Promise<void> {
  const open = connections;
  connections = [];
  await Promise.all(open.map((connection) => connection.close()));
}
