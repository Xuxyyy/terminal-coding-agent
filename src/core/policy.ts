export type Decision = 'allow' | 'ask';

export function decide(tool: string): Decision {
  return tool === 'bash' ? 'ask' : 'allow';
}

export function approvalKey(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}
