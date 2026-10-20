export type RetryBudget = {attempts: number};

export type RetryOptions = {
  retries: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  budget?: RetryBudget;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (nextAttempt: number, totalAttempts: number, delayMs: number) => void;
};

export const RETRIES = 3;

export class RecoveryExhaustedError extends Error {
  constructor(readonly attempts: number, cause: unknown) {
    super(`Model request recovery exhausted after ${attempts} attempts: ${errorFields(cause).message ?? 'request failed'}`, {cause});
    this.name = 'RecoveryExhaustedError';
  }
}

export function errorFields(error: unknown): {
  name?: string; code?: string; status?: number; message?: string;
  cause?: unknown; headers?: Headers | Record<string, string>; category?: string; type?: string;
} {
  if (typeof error !== 'object' || error === null) return {};
  const {name, code, status, message, cause, headers, category, type} = error as ReturnType<typeof errorFields>;
  return Object.fromEntries(Object.entries({name, code, status, message, cause, headers, category, type})
    .filter(([, value]) => value !== undefined));
}

function errorChain(error: unknown): ReturnType<typeof errorFields>[] {
  const chain: ReturnType<typeof errorFields>[] = [];
  const seen = new Set<unknown>();
  while (typeof error === 'object' && error !== null && !seen.has(error)) {
    seen.add(error);
    const fields = errorFields(error);
    chain.push(fields);
    error = fields.cause;
  }
  return chain;
}

export function rootError(error: unknown): ReturnType<typeof errorFields> {
  return errorChain(error).reduce((value, child) => ({...value, ...child, cause: child.cause}), {});
}

function categoryOf(value: ReturnType<typeof errorFields>): string | undefined {
  if (['AbortError', 'APIUserAbortError'].includes(value.name ?? '')) return 'cancelled';
  if (value.status === 401 || value.status === 403) return 'authentication';
  if (value.status === 402 || /insufficient[ _](balance|quota)|billing|credits? exhausted|requests? per day|\bdaily\b|\bRPD\b/i.test(value.message ?? '') || /insufficient_quota/.test(value.code ?? '')) return 'quota';
  if (value.code === 'context_length_exceeded' || /context.{0,30}(limit|length|exceed|window)|maximum context/i.test(value.message ?? '')) return 'context_limit';
  if (/^(authentication_error|invalid_api_key|permission_denied)$/i.test(value.code ?? value.type ?? '')) return 'authentication';
  if (value.status === 429 || /^(rate_limit_exceeded|rate_limit_error|too_many_requests)$/i.test(value.code ?? value.type ?? '')) return 'rate_limit';
  if (value.name === 'ModelTimeoutError' || value.name === 'APIConnectionTimeoutError') return 'timeout';
  if (/^(server_error|internal_error|server_overloaded|overloaded_error|service_unavailable)$/i.test(value.code ?? value.type ?? '')) return 'temporary';
  if (/^(request_timeout|timeout_error)$/i.test(value.code ?? value.type ?? '')) return 'timeout';
  if ([408, 409, 500, 502, 503, 504, 529].includes(value.status ?? 0)) return 'temporary';
  if (value.status !== undefined && value.status >= 400) return 'permanent';
  if (['APIConnectionError', 'TypeError'].includes(value.name ?? '') && (value.name !== 'TypeError' || /fetch failed|terminated/i.test(value.message ?? ''))) return 'connection';
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET'].includes(value.code ?? '')) return 'connection';
  if (value.code === 'INCOMPLETE_RESPONSE') return 'incomplete_response';
  return undefined;
}

export function errorCategory(error: unknown): string {
  const categories = errorChain(error).map((value) => value.category || categoryOf(value));
  return categories.find((category) => ['cancelled', 'authentication', 'quota', 'context_limit', 'permanent'].includes(category ?? ''))
    ?? categories.find((category) => category !== undefined) ?? 'permanent';
}

export function isRetryable(error: unknown): boolean {
  return ['timeout', 'rate_limit', 'temporary', 'connection', 'incomplete_response'].includes(errorCategory(error));
}

export function backoff(attempt: number): number {
  return 1_000 * 2 ** attempt;
}

export function retryDelay(error: unknown, attempt: number, now = Date.now()): number {
  const headers = rootError(error).headers;
  const get = (key: string) => headers instanceof Headers ? headers.get(key) : headers?.[key];
  const millis = get('retry-after-ms');
  if (millis && Number.isFinite(Number(millis)) && Number(millis) >= 0) return Number(millis);
  const after = get('retry-after');
  if (after) {
    const value = Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - now;
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return backoff(attempt);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(signal?.reason ?? new DOMException('Interrupted', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => { clean(); resolve(); }, Math.min(ms, 2_147_483_647));
    signal?.addEventListener('abort', abort, {once: true});
  });
}

export async function withRetry<T>(run: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
  const {retries = RETRIES, signal} = options;
  const budget = options.budget ?? {attempts: 0};
  const sleep = options.sleep ?? ((ms: number) => delay(ms, signal));
  for (;;) {
    signal?.throwIfAborted();
    if (budget.attempts > retries) throw new Error('model request recovery exhausted');
    budget.attempts += 1;
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted || !(options.shouldRetry ?? isRetryable)(error)) throw error;
      if (budget.attempts > retries) {
        if (retries === 0) throw error;
        throw new RecoveryExhaustedError(budget.attempts, error);
      }
      const wait = retryDelay(error, budget.attempts - 1);
      options.onRetry?.(budget.attempts + 1, retries + 1, wait);
      await sleep(wait);
      signal?.throwIfAborted();
    }
  }
}
