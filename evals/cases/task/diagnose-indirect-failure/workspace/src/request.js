import {retryDelay} from './retry-delay.js';

export function retryPlan(error, attempt) {
  return {
    message: error.message,
    attempt,
    waitMs: retryDelay(attempt),
  };
}
