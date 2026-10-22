import {sourceVersion} from '../source-version.js';
import type {SandboxMode} from '../sandbox/mode.js';
import {modelSettings, type ModelSettings, type ModelChoice} from '../client.js';
import type {AgentEvent, Usage} from '../host.js';
import {runAgent} from '../loop.js';
import {systemPrompt} from '../prompt.js';
import {addTask, createSession} from '../session.js';
import {modeOf} from '../settings.js';
import {DEFAULT_MAX_STEPS, validateMaxSteps} from './budget.js';
import {BackgroundTasks} from '../background.js';
import {toolsFor} from '../tools/index.js';
import {
  createHeadlessHost,
  type HeadlessTokenUsage,
  type HeadlessPolicy,
  type RecordedPrompt,
} from './host.js';

export type StopReason = 'done' | 'denied' | 'timeout' | 'step_limit' | 'error' | 'cancelled';

export type HeadlessResult = {
  text: string;
  execution?: {startedAt: string; elapsedMs: number; deadlineMs: number; permissionMode: string; policy: HeadlessPolicy; sandbox: SandboxMode; maxSteps: number; source: ReturnType<typeof sourceVersion>};
  modelSettings?: ModelSettings;
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
  signal?: AbortSignal;
  deadlineMs?: number;
  onEvent?: (event: AgentEvent) => void;
}): Promise<HeadlessResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  if (!Number.isFinite(options.maxSeconds)) throw new Error('maxSeconds must be finite');
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs)) throw new Error('deadlineMs must be finite');
  const deadlineMs = Math.min(Date.now() + options.maxSeconds * 1000, options.deadlineMs ?? Infinity);
  const monotonicDeadline = performance.now() + deadlineMs - Date.now();
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
  const interrupt = () => controller.abort(options.signal?.reason ?? new DOMException('Headless run interrupted', 'AbortError'));
  options.signal?.addEventListener('abort', interrupt, {once: true});
  if (options.signal?.aborted) interrupt();
  const {host, events, prompts, tokenUsage} = createHeadlessHost({
    policy: options.policy,
    signal: controller.signal,
    deadlineMs, maxSteps, onEvent: options.onEvent,
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  const remainingMs = monotonicDeadline - performance.now();
  if (remainingMs <= 0) {
    timedOut = true;
    controller.abort(new DOMException('Trial deadline reached', 'TimeoutError'));
  } else {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Trial deadline reached', 'TimeoutError'));
    }, Math.min(remainingMs, 2_147_483_647));
  }

  host.onEvent({type: 'run_start', schemaVersion: 2, settings: {startedAt, deadlineMs, permissionMode: session.mode, policy: options.policy, sandbox: session.sandbox, maxSteps, source: sourceVersion(), model: modelSettings(options.choice)}});

  let outcome: 'step_limit' | void = undefined;
  const backgroundTasks = new BackgroundTasks({signal: controller.signal, onEvent: host.onEvent});
  try {
    outcome = await runAgent(
      session, options.choice, host, toolsFor(session.mode, true), undefined,
      {maxSteps, backgroundTasks, waitForBackground: true},
    );
  } finally {
    try {
      const normalCompletion = !controller.signal.aborted && outcome !== 'step_limit' &&
        !events.some((event) => event.type === 'error') && !prompts.some((prompt) => prompt.decision === 'deny') &&
        events.some((event) => event.type === 'turn_end');
      try {
        await backgroundTasks.close(timedOut ? 'run deadline reached' : 'headless run ended', normalCompletion);
      } catch (error) {
        host.onEvent({type: 'error', message: (error as Error).message});
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', interrupt);
    }
  }

  let text = '';
  const usage: Usage = {...session.usage};
  let error: string | undefined;
  for (const event of events) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'model_attempt' && event.evidence.agentId === 'main' && event.evidence.outcome === 'failed' && event.evidence.partial?.toolCalls.length && event.evidence.partial.content) {
      text = text.slice(0, Math.max(0, text.length - event.evidence.partial.content.length));
    }
    if (event.type === 'error' && error === undefined) error = event.message;
  }

  const denied = prompts.some((prompt) => prompt.decision === 'deny');
  if (options.signal?.aborted) error ??= 'headless run interrupted';
  if (timedOut) error ??= 'trial deadline reached';
  const stopped: StopReason = timedOut
    ? 'timeout'
    : options.signal?.aborted
      ? 'cancelled'
    : outcome === 'step_limit'
      ? 'step_limit'
      : denied
        ? 'denied'
        : error !== undefined
          ? 'error'
          : 'done';

  return {
    text,
    execution: {startedAt, elapsedMs: performance.now() - started, deadlineMs, permissionMode: session.mode, policy: options.policy, sandbox: session.sandbox, maxSteps, source: sourceVersion()},
    modelSettings: modelSettings(options.choice),
    events,
    prompts,
    usage,
    tokenUsage,
    stopped,
    ...(error ? {error} : {}),
  };
}
