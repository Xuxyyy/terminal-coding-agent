export const DEFAULT_MAX_STEPS: number = 120;

export function validateMaxSteps(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('--max-steps needs a positive safe integer');
  }
  return value;
}
