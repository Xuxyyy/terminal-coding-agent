export type RetryOptions = {
  retries: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export const RETRIES = 3;

export function backoff(attempt: number): number {
  throw new Error(`not implemented: backoff(${attempt})`);
}

export function isRetryable(error: unknown): boolean {
  throw new Error(`not implemented: isRetryable(${String(error)})`);
}

export async function withRetry<T>(
  run: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  void run;
  void options;
  throw new Error('not implemented: withRetry');
}
