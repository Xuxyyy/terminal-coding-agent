#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'hanging', version: '0.0.1'});

server.registerTool(
  'hang',
  {
    description: 'accept the call and never answer it',
    inputSchema: {text: z.string().describe('the text that is never echoed back')},
  },
  async () => new Promise(() => {}),
);

await server.connect(new StdioServerTransport());
