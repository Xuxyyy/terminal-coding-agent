export type RetryOptions = {
  retries: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export const RETRIES = 3;

const FIRST_BACKOFF_MS = 1_000;

const ABORT_NAMES = new Set(['AbortError', 'APIUserAbortError']);

const CONNECTION_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

type ErrorFields = {name?: unknown; code?: unknown; status?: unknown};

function fieldsOf(error: unknown): ErrorFields {
  return typeof error === 'object' && error !== null
    ? (error as ErrorFields)
    : {};
}

export function backoff(attempt: number): number {
  return FIRST_BACKOFF_MS * 2 ** attempt;
}

export function isRetryable(error: unknown): boolean {
  const {name, code, status} = fieldsOf(error);
  if (typeof name === 'string' && ABORT_NAMES.has(name)) return false;
  if (typeof name === 'string' && CONNECTION_NAMES.has(name)) return true;
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  if (typeof status !== 'number') return false;
  return status === 429 || status >= 500;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, {once: true});
  });
}

export async function withRetry<T>(
  run: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const {retries = RETRIES, signal} = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, signal));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries) throw error;
      if (signal?.aborted) throw error;
      if (!isRetryable(error)) throw error;
      await sleep(backoff(attempt));
      if (signal?.aborted) throw error;
    }
  }
}
