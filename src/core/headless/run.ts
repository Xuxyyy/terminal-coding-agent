import type {ModelChoice} from '../client.js';
import type {AgentEvent, Usage} from '../host.js';
import {runAgent} from '../loop.js';
import {systemPrompt} from '../prompt.js';
import {addTask, createSession} from '../session.js';
import {modeOf} from '../settings.js';
import {
  createHeadlessHost,
  type HeadlessPolicy,
  type RecordedPrompt,
} from './host.js';

export type StopReason = 'done' | 'denied' | 'timeout' | 'error';

export type HeadlessResult = {
  text: string;
  events: AgentEvent[];
  prompts: RecordedPrompt[];
  usage: Usage;
  stopped: StopReason;
  error?: string;
};

export async function runHeadless(options: {
  root: string;
  task: string;
  choice: ModelChoice;
  policy: HeadlessPolicy;
  maxSeconds: number;
}): Promise<HeadlessResult> {
  const session = createSession(
    options.root,
    systemPrompt(options.root, modeOf()),
    options.choice.contextWindow,
  );
  addTask(session, options.task);

  const controller = new AbortController();
  const {host, events, prompts} = createHeadlessHost({
    policy: options.policy,
    signal: controller.signal,
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  if (options.maxSeconds <= 0) {
    timedOut = true;
    controller.abort();
  } else {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.maxSeconds * 1000);
  }

  try {
    await runAgent(session, options.choice, host, undefined, undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let text = '';
  let usage: Usage = {prompt: 0, completion: 0, total: 0};
  let error: string | undefined;
  for (const event of events) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'turn_end') usage = event.usage;
    if (event.type === 'error' && error === undefined) error = event.message;
  }

  const denied = prompts.some((prompt) => prompt.decision === 'deny');
  const stopped: StopReason = timedOut
    ? 'timeout'
    : denied
      ? 'denied'
      : error !== undefined
        ? 'error'
        : 'done';

  return {text, events, prompts, usage, stopped, ...(error ? {error} : {})};
}
