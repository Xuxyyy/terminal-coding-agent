#!/usr/bin/env node
import {render} from 'ink';
import {createClient} from './core/client.js';
import {evictSessions} from './core/store.js';
import {App} from './ui/app.js';
import {parseArgs} from './ui/args.js';
import {dimText, formatExitSummary} from './ui/exit-summary.js';

try {
  const options = parseArgs(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive mode requires a terminal');
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
  if (summary) {
    process.stdout.write(`\n${dimText(summary)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
