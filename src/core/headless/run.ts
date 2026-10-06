import type {SandboxMode} from '../sandbox/mode.js';
import type {ModelChoice} from '../client.js';
import type {AgentEvent, Usage} from '../host.js';
import {runAgent} from '../loop.js';
import {systemPrompt} from '../prompt.js';
import {addTask, createSession} from '../session.js';
import {modeOf} from '../settings.js';
import {DEFAULT_MAX_STEPS, validateMaxSteps} from './budget.js';
import {
  createHeadlessHost,
  type HeadlessTokenUsage,
  type HeadlessPolicy,
  type RecordedPrompt,
} from './host.js';

export type StopReason = 'done' | 'denied' | 'timeout' | 'step_limit' | 'error';

export type HeadlessResult = {
  text: string;
  events: AgentEvent[];
  prompts: RecordedPrompt[];
  usage: Usage;
  tokenUsage: HeadlessTokenUsage;
  stopped: StopReason;
  error?: string;
};

export async function runHeadless(options: {
  root: string;
  task: string;
  choice: ModelChoice;
  policy: HeadlessPolicy;
  maxSeconds: number;
  maxSteps?: number;
  sandbox?: SandboxMode;
}): Promise<HeadlessResult> {
  const maxSteps = validateMaxSteps(options.maxSteps ?? DEFAULT_MAX_STEPS);
  const session = createSession(
    options.root,
    systemPrompt(options.root, modeOf(), options.sandbox) +
      `\n\nHeadless run budget: at most ${maxSteps} model turns, including the final answer. ` +
      'Execution stops when this budget or the time limit is reached.',
    options.choice.contextWindow,
    options.sandbox,
  );
  addTask(session, options.task);

  const controller = new AbortController();
  const {host, events, prompts, tokenUsage} = createHeadlessHost({
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

  let outcome: 'step_limit' | void;
  try {
    outcome = await runAgent(
      session, options.choice, host, undefined, undefined, {maxSteps},
    );
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
    : outcome === 'step_limit'
      ? 'step_limit'
      : denied
        ? 'denied'
        : error !== undefined
          ? 'error'
          : 'done';

  return {
    text,
    events,
    prompts,
    usage,
    tokenUsage,
    stopped,
    ...(error ? {error} : {}),
  };
}
