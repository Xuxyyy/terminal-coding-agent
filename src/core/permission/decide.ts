import {type Rules} from '../settings.js';
import {
  classifyCommand,
  classifyRead,
  classifyWrite,
  type Classification,
} from './classify.js';
import {hardenCommand} from './harden.js';
import {aboveCut, DEFAULT_MODE, withinCut, type Mode} from './mode.js';
import {pathVerdict, ruleVerdict, type RuleVerdict} from './rules.js';
import {commandParts, splitStages} from './stages.js';

export type Request =
  | {kind: 'command'; command: string; reason?: string}
  | {kind: 'write'; path: string}
  | {kind: 'read'; path: string}
  | {kind: 'mcp'; server: string; tool: string};

export type Outcome = {
  decision: 'allow' | 'ask' | 'deny' | 'judge';
  reason: string;
  command?: string;
  suppressible: boolean;
};

const UNCLASSIFIED_REASON = 'cannot be classified from its text';

export const MCP_REASON = 'an MCP server outside the workspace runs this';

function outcomeFor(
  classification: Classification,
  mode: Mode,
  fallback?: string,
): Outcome {
  const {level, reason} = classification;
  if (withinCut(level, mode)) {
    return {decision: 'allow', reason, suppressible: true};
  }
  const explained = level === null ? (fallback ?? UNCLASSIFIED_REASON) : reason;
  return {
    decision: aboveCut(mode),
    reason: explained,
    suppressible: level !== 'escape',
  };
}

const RULE_REASON = {
  deny: 'denied by a rule in settings.json',
  ask: 'a rule in settings.json asks about this',
  allow: 'allowed by a rule in settings.json',
};

function fileOutcome(
  classification: Classification,
  mode: Mode,
  verdict: RuleVerdict | null,
): Outcome {
  if (verdict === 'deny') {
    return {decision: 'deny', reason: RULE_REASON.deny, suppressible: false};
  }
  if (classification.level === 'escape') {
    return outcomeFor(classification, mode);
  }
  if (verdict !== null) {
    return {decision: verdict, reason: RULE_REASON[verdict], suppressible: true};
  }
  return outcomeFor(classification, mode);
}

const NO_RULES: Rules = {allow: [], ask: [], deny: []};

export function decide(
  request: Request,
  root: string,
  rules: Rules = NO_RULES,
  mode: Mode = DEFAULT_MODE,
): Outcome {
  if (request.kind === 'mcp') {
    return outcomeFor({level: null, reason: ''}, mode, MCP_REASON);
  }
  if (request.kind === 'write') {
    return fileOutcome(
      classifyWrite(request.path, root),
      mode,
      pathVerdict(request.path, root, rules),
    );
  }
  if (request.kind === 'read') {
    const verdict = pathVerdict(request.path, root, rules);
    return fileOutcome(
      classifyRead(request.path, root),
      mode,
      verdict === 'deny' ? 'deny' : null,
    );
  }
  const command = hardenCommand(request.command);
  const verdict = ruleVerdict(command, rules);
  if (verdict === 'deny') {
    return {decision: 'deny', reason: RULE_REASON.deny, suppressible: false, command};
  }
  const classification = classifyCommand(command, root);
  if (classification.level === 'escape') {
    return {...outcomeFor(classification, mode, request.reason), command};
  }
  if (verdict !== null) {
    return {
      decision: verdict,
      reason: RULE_REASON[verdict],
      suppressible: true,
      command,
    };
  }
  return {...outcomeFor(classification, mode, request.reason), command};
}

export function approvalKey(request: Request): string {
  if (request.kind === 'write') return `write ${request.path}`;
  if (request.kind === 'read') return `read ${request.path}`;
  if (request.kind === 'mcp') return `mcp ${request.server} ${request.tool}`;
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
