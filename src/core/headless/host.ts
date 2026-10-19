import type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
  Host,
  ModelTokenUsage,
  RequestEvidence,
} from '../host.js';

export type HeadlessPolicy = 'deny' | 'yes';

export type RecordedPrompt = {
  request: ConfirmRequest;
  decision: ConfirmDecision;
};

export type RequestTokenUsage = ModelTokenUsage & {request: number};

export type HeadlessTokenUsage = {
  requests: RequestTokenUsage[];
  totals: ModelTokenUsage;
  attempts?: RequestEvidence[];
  complete?: boolean;
};

export type HeadlessHost = {
  host: Host;
  events: AgentEvent[];
  prompts: RecordedPrompt[];
  tokenUsage: HeadlessTokenUsage;
};

function emptyTokenUsage(): ModelTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
  };
}

function addTokenUsage(target: ModelTokenUsage, usage: ModelTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheHitInputTokens += usage.cacheHitInputTokens;
  target.cacheMissInputTokens += usage.cacheMissInputTokens;
}

function decide(
  request: ConfirmRequest,
  policy: HeadlessPolicy,
): ConfirmDecision {
  if (request.command === 'continue') return 'deny';
  return policy === 'yes' ? 'once' : 'deny';
}

export function createHeadlessHost(options: {
  policy: HeadlessPolicy;
  signal: AbortSignal;
  deadlineMs?: number;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}): HeadlessHost {
  const events: AgentEvent[] = [];
  const prompts: RecordedPrompt[] = [];
  const tokenUsage: HeadlessTokenUsage = {
    requests: [],
    totals: emptyTokenUsage(),
    attempts: [],
    complete: true,
  };
  const host: Host = {
    signal: options.signal,
    agentId: 'main',
    deadlineMs: options.deadlineMs,
    maxSteps: options.maxSteps,
    onEvent(event) {
      events.push(event);
      if (event.type === 'model_attempt') {
        tokenUsage.attempts!.push(event.evidence);
        if (!event.evidence.usage || event.evidence.missingUsageFields?.length) tokenUsage.complete = false;
      }
      options.onEvent?.(event);
    },
    onDiagnostic(event) { host.onEvent(event); },
    onModelUsage(usage) {
      tokenUsage.requests.push({
        request: tokenUsage.requests.length + 1,
        ...usage,
      });
      addTokenUsage(tokenUsage.totals, usage);
    },
    async confirm(request) {
      const decision = decide(request, options.policy);
      prompts.push({request, decision});
      return decision;
    },
  };
  return {host, events, prompts, tokenUsage};
}
