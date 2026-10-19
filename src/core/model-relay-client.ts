export function relayError(value: unknown): Error {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const categories = ['timeout', 'rate_limit', 'temporary', 'connection', 'incomplete_response', 'authentication', 'quota', 'context_limit', 'permanent'];
  const category = typeof data.category === 'string' && categories.includes(data.category) ? data.category : typeof data.status === 'number' && data.status < 500 && data.status !== 429 ? 'permanent' : 'temporary';
  return Object.assign(new Error(`Model relay request failed: ${category}`), {
    category,
    ...(typeof data.status === 'number' ? {status: data.status} : {}),
    ...(typeof data.retryAfterMs === 'number' && Number.isFinite(data.retryAfterMs) && data.retryAfterMs >= 0
      ? {headers: {'retry-after-ms': String(data.retryAfterMs)}} : {}),
  });
}

import {metadataHeaders, type Invoke} from './deepseek.js';

export function relayInvoke(endpoint: string): Invoke {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('ACC_MODEL_RELAY_URL must be an HTTP endpoint without user credentials or a fragment');
  }
  return async (request, signal, metadata) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...metadataHeaders(metadata)},
      body: JSON.stringify(request),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({status: response.status}));
      throw relayError(body);
    }
    if (!request.stream) return response.json();
    if (!response.body) throw new Error('model relay returned no stream');
    return events(response.body);
  };
}

async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, {stream: !chunk.done});
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const event = JSON.parse(line) as {event?: unknown; done?: boolean; error?: unknown};
        if (event.error) throw relayError(event.error);
        if (event.done) {
          complete = true;
          return;
        }
        yield event.event;
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('model relay event is too large');
      if (chunk.done) break;
    }
    if (!complete) throw Object.assign(new Error('model relay stream ended early'), {code: 'INCOMPLETE_RESPONSE'});
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
