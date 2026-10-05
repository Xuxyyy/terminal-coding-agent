export type SandboxMode = 'off' | 'on';

export const DEFAULT_SANDBOX: SandboxMode = 'off';

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'off' || value === 'on';
}
