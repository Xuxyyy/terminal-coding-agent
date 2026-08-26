#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'many-tools', version: '0.0.1'});

const NAMES = ['list_issues', 'list_prs', 'get_file', 'search_code', 'create_issue'];

for (const name of NAMES) {
  server.registerTool(
    name,
    {
      description: `the ${name} tool`,
      inputSchema: {query: z.string().describe('what to ask for')},
    },
    async ({query}) => ({content: [{type: 'text', text: `${name}: ${query}`}]}),
  );
}

await server.connect(new StdioServerTransport());
