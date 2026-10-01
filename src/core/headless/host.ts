import type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
  Host,
  ModelTokenUsage,
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
}): HeadlessHost {
  const events: AgentEvent[] = [];
  const prompts: RecordedPrompt[] = [];
  const tokenUsage: HeadlessTokenUsage = {
    requests: [],
    totals: emptyTokenUsage(),
  };
  const host: Host = {
    signal: options.signal,
    onEvent(event) {
      events.push(event);
    },
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
