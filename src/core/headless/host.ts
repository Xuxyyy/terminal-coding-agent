import type {
  AgentEvent,
  ConfirmDecision,
  ConfirmRequest,
  Host,
} from '../host.js';

export type HeadlessPolicy = 'deny' | 'yes';

export type RecordedPrompt = {
  request: ConfirmRequest;
  decision: ConfirmDecision;
};

export type HeadlessHost = {
  host: Host;
  events: AgentEvent[];
  prompts: RecordedPrompt[];
};

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
  const host: Host = {
    signal: options.signal,
    onEvent(event) {
      events.push(event);
    },
    async confirm(request) {
      const decision = decide(request, options.policy);
      prompts.push({request, decision});
      return decision;
    },
  };
  return {host, events, prompts};
}
