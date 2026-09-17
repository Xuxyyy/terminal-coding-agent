const BASE_DELAY_MS = 100;

export function retryDelay(attempt) {
  return BASE_DELAY_MS * attempt;
}
