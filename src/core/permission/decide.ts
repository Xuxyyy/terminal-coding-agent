import {classifyCommand, classifyWrite, type Classification, type Level} from './classify.js';
import {hardenCommand} from './harden.js';
import {commandParts, splitStages} from './stages.js';

export type Request =
  | {kind: 'command'; command: string; reason?: string}
  | {kind: 'write'; path: string};

export type Outcome = {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  command?: string;
  suppressible: boolean;
};

const ALLOWED_LEVELS: Level[] = ['observe', 'recoverable'];
const UNCLASSIFIED_REASON = 'cannot be classified from its text';

function outcomeFor(classification: Classification, fallback?: string): Outcome {
  const {level, reason} = classification;
  if (level !== null && ALLOWED_LEVELS.includes(level)) {
    return {decision: 'allow', reason, suppressible: true};
  }
  return {
    decision: 'ask',
    reason: level === null ? (fallback ?? UNCLASSIFIED_REASON) : reason,
    suppressible: level !== 'escape',
  };
}

export function decide(request: Request, root: string): Outcome {
  if (request.kind === 'write') {
    return outcomeFor(classifyWrite(request.path, root));
  }
  const command = hardenCommand(request.command);
  return {...outcomeFor(classifyCommand(command, root), request.reason), command};
}

export function approvalKey(request: Request): string {
  if (request.kind === 'write') return `write ${request.path}`;
  const stages = splitStages(request.command);
  if (stages === null) return request.command.trim();
  return stages
    .map((stage) => stage.text.trim())
    .filter((text) => text)
    .map((text) => {
      const parts = commandParts(text);
      return parts?.length ? parts.join(' ') : text;
    })
    .join('; ');
}
