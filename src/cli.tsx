#!/usr/bin/env node
import {render} from 'ink';
import {createClient} from './core/client.js';
import {exitCode, jsonLines, plainLines} from './core/headless/output.js';
import {runHeadless} from './core/headless/run.js';
import {connectServers, disconnectServers, serverStatus} from './core/mcp/connect.js';
import {evictSessions} from './core/projects.js';
import {loadSettings, settingsFiles} from './core/settings.js';
import {App} from './ui/app.js';
import {parseArgs} from './ui/args.js';
import {dimText, formatExitSummary} from './ui/exit-summary.js';

try {
  const options = parseArgs(process.argv.slice(2));
  loadSettings(settingsFiles(options.workspaceRoot));
  if (options.print !== null) {
    await connectServers();
    const choice = createClient();
    const result = await runHeadless({
      root: options.workspaceRoot,
      task: options.print,
      choice,
      policy: options.yes ? 'yes' : 'deny',
      maxSeconds: options.maxSeconds,
    });
    await disconnectServers();
    if (options.json) {
      for (const line of jsonLines(result)) {
        process.stdout.write(`${line}\n`);
      }
    } else {
      const {out, err} = plainLines(result);
      for (const line of err) {
        process.stderr.write(`${line}\n`);
      }
      if (out) {
        process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
      }
    }
    process.exitCode = exitCode(result);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('interactive mode requires a terminal');
    }
    await connectServers();
    for (const server of serverStatus()) {
      if (server.state === 'failed') {
        process.stderr.write(`warning: MCP server ${server.label} ${server.error}\n`);
      }
    }
    try {
      evictSessions();
    } catch {
      process.stderr.write('warning: could not tidy old sessions\n');
    }
    const choice = createClient();
    let summary: string | null = null;
    const instance = render(
      <App
        workspaceRoot={options.workspaceRoot}
        choice={choice}
        onCleanExit={() => {
          summary = formatExitSummary();
          instance.rerender(null);
          setTimeout(() => {
            instance.clear();
            instance.unmount();
          }, 50);
        }}
      />,
    );
    await instance.waitUntilExit();
    await disconnectServers();
    if (summary) {
      process.stdout.write(`\n${dimText(summary)}\n`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
