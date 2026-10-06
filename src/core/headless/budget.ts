import {NORMAL_STEP_POLICY} from '../step-policy.js';

export const DEFAULT_MAX_STEPS: number = NORMAL_STEP_POLICY.hardGateEvery;

export function validateMaxSteps(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('--max-steps needs a positive safe integer');
  }
  return value;
}
