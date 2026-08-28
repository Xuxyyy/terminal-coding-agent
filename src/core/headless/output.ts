import type {HeadlessResult} from './run.js';

export type PlainOutput = {out: string; err: string[]};

export function plainLines(result: HeadlessResult): PlainOutput {
  const err: string[] = [];
  for (const event of result.events) {
    if (event.type === 'tool_start') err.push(`tool: ${event.name}`);
  }
  for (const prompt of result.prompts) {
    err.push(`prompt: ${prompt.request.command} -> ${prompt.decision}`);
  }
  if (result.stopped !== 'done') {
    const detail = result.error ? `: ${result.error}` : '';
    err.push(`stopped: ${result.stopped}${detail}`);
  }
  return {out: result.text, err};
}

export function jsonLines(result: HeadlessResult): string[] {
  const lines = result.events.map((event) => JSON.stringify(event));
  const steps = result.events.filter(
    (event) => event.type === 'tool_start',
  ).length;
  lines.push(
    JSON.stringify({
      kind: 'result',
      stopped: result.stopped,
      usage: result.usage,
      prompts: result.prompts.length,
      steps,
      ...(result.error ? {error: result.error} : {}),
    }),
  );
  return lines;
}

export function exitCode(result: HeadlessResult): 0 | 1 {
  return result.stopped === 'done' ? 0 : 1;
}
