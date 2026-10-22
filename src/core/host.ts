export type DiffRow = {
  kind: 'context' | 'add' | 'remove' | 'gap';
  line?: number;
  text?: string;
};

export type DiffPayload = {
  path: string;
  rows: DiffRow[];
  hidden: number;
  added: number;
  removed: number;
};

export type Usage = {prompt: number; completion: number; total: number};

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
};

export type RequestEvidence = {
  requestId: string; agentId: string; attempt: number;
  startedAt: string; elapsedMs: number; outcome: string; category?: string;
  timeoutPhase?: string; usage: ModelTokenUsage | null; missingUsageFields?: string[];
  partial?: {reasoning?: string; content: string; toolCalls: {id: string; name: string; args: string}[]};
};

export type AgentEvent =
  | {type: 'run_start'; schemaVersion: 2; settings: Record<string, unknown>}
  | {type: 'model_attempt'; evidence: RequestEvidence}
  | {type: 'model_attempt_start'; requestId: string; agentId: string; attempt: number; startedAt: string}
  | {type: 'recovery'; kind: 'continuation' | 'context'; requestId?: string; agentId: string; recoveryId: string; startedAt: string; fromRequestId?: string}
  | {type: 'response_incomplete'; agentId: string; reason: string}
  | {type: 'background_task'; action: 'started' | 'completed' | 'handed_off'; task: BackgroundTaskInfo}
  | {type: 'model_request_start'; request: number}
  | {type: 'text_delta'; text: string}
  | {type: 'thinking_delta'; text: string; requestId: string; agentId: string; attempt: number}
  | {type: 'model_retry'; attempt: number; total: number; delayMs?: number; requestId?: string}
  | {type: 'tool_start'; id: string; name: string; args: unknown}
  | {
      type: 'tool_end';
      id: string;
      name: string;
      result: string;
      diff: DiffPayload | null;
      execution?: string;
    }
  | {type: 'turn_end'; usage: Usage}
  | {type: 'context_threshold_reached'}
  | {type: 'compact_start'}
  | {type: 'compact_end'; replaced: number; before: number; after: number}
  | {type: 'error'; message: string; hint?: string};

export type BackgroundTaskInfo = {
  id: string;
  owner: string;
  command: string;
  description?: string;
  lifetime?: 'finite' | 'temporary_service' | 'retained_service';
  requiredByTask?: string;
  startedAt?: string;
  pid?: number;
  processExited?: boolean;
  readiness?: {command: string; verifiedAt: string; output: string};
  handoff?: {at: string; recordPath: string; stopCommand: string; runtimePath: string};
  outputIncomplete?: boolean;
  cleanupUncertain?: boolean;
  status: 'running' | 'handed_off' | 'completed' | 'failed' | 'stopped' | 'timed_out' | 'output_limit';
  logPath: string;
  code: number | null;
  reason?: string;
  characters: number;
};

export const INTERRUPTED = '[interrupted by the user]';

export const INTERRUPTED_TURN = '[the user interrupted this turn]';

export type ConfirmDecision = 'once' | 'session' | 'deny';

export type ConfirmRequest = {
  command: string;
  reason: string;
  suppressible: boolean;
};

export interface Host {
  confirm(request: ConfirmRequest): Promise<ConfirmDecision>;
  onEvent(event: AgentEvent): void;
  onModelUsage?(usage: ModelTokenUsage): void;
  signal: AbortSignal;
  agentId?: string;
  deadlineMs?: number;
  maxSteps?: number;
  onDiagnostic?(event: AgentEvent): void;
}
