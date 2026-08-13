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

export type AgentEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'tool_start'; id: string; name: string; args: unknown}
  | {
      type: 'tool_end';
      id: string;
      name: string;
      result: string;
      diff: DiffPayload | null;
    }
  | {type: 'turn_end'; usage: Usage}
  | {type: 'compact_start'}
  | {type: 'compact_end'; replaced: number; before: number; after: number}
  | {type: 'error'; message: string};

export type ConfirmDecision = 'once' | 'session' | 'deny';

export type ConfirmRequest = {
  command: string;
  reason: string;
  suppressible: boolean;
};

export interface Host {
  confirm(request: ConfirmRequest): Promise<ConfirmDecision>;
  onEvent(event: AgentEvent): void;
  signal: AbortSignal;
}
