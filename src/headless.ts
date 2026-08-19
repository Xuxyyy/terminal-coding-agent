import {createClient} from './core/client.js';
import type {ConfirmDecision, Host} from './core/host.js';
import {runAgent} from './core/loop.js';
import {systemPrompt} from './core/prompt.js';
import {addTask, createSession} from './core/session.js';
import {loadSettings, modeOf, settingsFiles} from './core/settings.js';
import {formatArgs, resultStatus} from './ui/events.js';

const task = process.argv.slice(2).join(' ');
if (!task) {
  console.error('usage: node dist/headless.js "<task>"');
  process.exit(2);
}

const root = process.cwd();
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const host: Host = {
  signal: controller.signal,
  async confirm(): Promise<ConfirmDecision> {
    return 'once';
  },
  onEvent(event) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text);
      return;
    }
    if (event.type === 'tool_start') {
      const summary = formatArgs(event.name, event.args, root);
      process.stdout.write(`\n• ${event.name} ${summary}\n`);
      return;
    }
    if (event.type === 'tool_end') {
      process.stdout.write(`  → ${resultStatus(event.name, event.result)}\n`);
      return;
    }
    if (event.type === 'error') {
      process.stdout.write(`\n✖ ${event.message}\n`);
      return;
    }
    if (event.type === 'context_threshold_reached') {
      process.stdout.write('\ncompaction threshold reached\n');
      return;
    }
    if (
      event.type === 'context_cleared' ||
      event.type === 'compact_start' ||
      event.type === 'compact_end'
    ) {
      return;
    }
    process.stdout.write(
      `\n[${event.usage.total.toLocaleString('en-US')} tokens]\n`,
    );
  },
};

const choice = createClient();
loadSettings(settingsFiles(root));
const session = createSession(root, systemPrompt(root, modeOf()), choice.contextWindow);
addTask(session, task);
await runAgent(session, choice, host);
