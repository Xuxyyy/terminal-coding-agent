#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const sleep = Number(process.env.ECHO_SLEEP_MS ?? '0');
if (sleep > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleep));
}

const server = new McpServer({name: 'echo', version: '0.0.1'});

server.registerTool(
  'echo',
  {
    description: 'echo the text back',
    inputSchema: {text: z.string().describe('the text to echo back')},
  },
  async ({text}) => {
    if (text === 'boom') {
      return {isError: true, content: [{type: 'text', text: 'the echo server refused'}]};
    }
    return {content: [{type: 'text', text: `echo: ${text}`}]};
  },
);

await server.connect(new StdioServerTransport());
