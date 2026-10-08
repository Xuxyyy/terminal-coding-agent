import type {Invoke} from './gemini.js';

export function relayInvoke(endpoint: string): Invoke {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('ACC_MODEL_RELAY_URL must be an HTTP endpoint without user credentials or a fragment');
  }
  return async (request, signal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(request),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`model relay rejected the request (HTTP ${response.status})`);
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
        const event = JSON.parse(line) as {event?: unknown; done?: boolean; error?: boolean};
        if (event.error) throw new Error('model relay request failed');
        if (event.done) {
          complete = true;
          return;
        }
        yield event.event;
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('model relay event is too large');
      if (chunk.done) break;
    }
    if (!complete) throw new Error('model relay stream ended early');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
