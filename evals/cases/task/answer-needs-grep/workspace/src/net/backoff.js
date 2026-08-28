export function backoff(attempt) {
  return Math.min(250 * 2 ** attempt, 30000);
}
