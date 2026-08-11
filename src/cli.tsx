#!/usr/bin/env node
import {render} from 'ink';
import {createClient} from './core/client.js';
import {
  evictSessions,
  listSessions,
  loadSession,
  type SessionMeta,
} from './core/store.js';
import {App} from './ui/app.js';
import {parseArgs} from './ui/args.js';
import {dimText, formatExitSummary} from './ui/exit-summary.js';

function sessionLine(meta: SessionMeta): string {
  const when = meta.startedAt.replace('T', ' ').slice(0, 16);
  const tokens = meta.usage.total.toLocaleString('en-US');
  return `${meta.id}  ${when}  ${tokens} tokens  ${meta.status}`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.sessions) {
    const found = listSessions(options.workspaceRoot);
    const lines = found.length
      ? found.map(sessionLine)
      : ['no sessions for this folder'];
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive mode requires a terminal');
  }
  const restored = options.resume
    ? loadSession(options.workspaceRoot, options.resumeId)
    : null;
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
      restored={restored}
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
