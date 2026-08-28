import type {AgentEvent} from '../../core/host.js';
import type {RecordedPrompt} from '../../core/headless/host.js';

export const TOOL_ERROR_PREFIX = 'Error: ';

export const RESULT_LIMIT = 1_000;

export type Metrics = {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  tokens: number;
  prompts: number;
};

export type TranscriptCall = {name: string; args: unknown; result: string};

export type Transcript = {text: string; calls: TranscriptCall[]};

export function metricsOf(
  events: AgentEvent[],
  prompts: RecordedPrompt[],
): Metrics {
  let toolCalls = 0;
  let toolErrors = 0;
  let tokens = 0;
  for (const event of events) {
    if (event.type === 'tool_start') toolCalls += 1;
    if (event.type === 'tool_end' && event.result.startsWith(TOOL_ERROR_PREFIX)) {
      toolErrors += 1;
    }
    if (event.type === 'turn_end') tokens = event.usage.total;
  }
  return {steps: toolCalls, toolCalls, toolErrors, tokens, prompts: prompts.length};
}

function truncate(text: string, limit = RESULT_LIMIT): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

export function transcriptOf(events: AgentEvent[]): Transcript {
  const args = new Map<string, unknown>();
  const names = new Map<string, string>();
  const calls: TranscriptCall[] = [];
  let text = '';
  for (const event of events) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'tool_start') {
      args.set(event.id, event.args);
      names.set(event.id, event.name);
    }
    if (event.type === 'tool_end') {
      calls.push({
        name: event.name || names.get(event.id) || '',
        args: args.get(event.id),
        result: truncate(event.result),
      });
    }
  }
  return {text, calls};
}
