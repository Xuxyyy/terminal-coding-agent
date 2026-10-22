import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {deepseekInvoke, type Invoke} from './deepseek.js';
import {errorCategory, retryDelay, rootError} from './retry.js';
import {DEFAULT_MODEL, MAX_OUTPUT_TOKENS} from './models.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const messageSchema = z.discriminatedUnion('role', [
  z.object({role: z.enum(['system', 'developer', 'user']), content: z.string()}).strict(),
  z.object({
    role: z.literal('assistant'), content: z.string().nullable(), reasoning_content: z.string().optional(),
    tool_calls: z.array(z.object({
      id: z.string(), type: z.literal('function'),
      function: z.object({name: z.string(), arguments: z.string()}).strict(),
    }).strict()).optional(),
  }).strict(),
  z.object({role: z.literal('tool'), tool_call_id: z.string(), content: z.string()}).strict(),
]);
const codingRequestSchema = z.object({
  model: z.literal(DEFAULT_MODEL),
  messages: z.array(messageSchema),
  stream: z.boolean(),
  stream_options: z.object({include_usage: z.literal(true)}).strict().optional(),
  max_tokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
  reasoning_effort: z.enum(['none', 'low', 'high', 'max']),
  thinking: z.object({type: z.enum(['enabled', 'disabled'])}).strict(),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(), description: z.string().optional(), parameters: z.record(z.unknown()).optional(),
    }).strict(),
  }).strict()).optional(),
}).strict().refine((body) => (body.reasoning_effort === 'none') === (body.thinking.type === 'disabled'));
const requestSchema = codingRequestSchema;

export type ModelRelay = {
  port: number;
  path: string;
  close(): Promise<void>;
};

export async function startModelRelay(options: {
  apiKey: string;
  model: string;
  maxSeconds: number;
  deadlineMs?: number;
  maxRequests?: number;
  bindHost?: string;
  invoke?: Invoke;
}): Promise<ModelRelay> {
  if (options.model !== DEFAULT_MODEL) throw new Error('model relay requires a model supported by this ACC runtime');
  if (!options.apiKey) throw new Error('model relay requires a provider key on the host');
  if (!Number.isInteger(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86_400) {
    throw new Error('model relay duration must be between 1 and 86400 seconds');
  }
  const maxRequests = options.maxRequests ?? 128;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1024) {
    throw new Error('model relay request limit must be between 1 and 1024');
  }
  const path = `/${randomBytes(32).toString('hex')}/interactions`;
  const invoke = options.invoke ?? deepseekInvoke(options.apiKey);
  const controllers = new Set<AbortController>();
  let requests = 0;
  let closed = false;
  const duration = Math.min(options.maxSeconds * 1000, (options.deadlineMs ?? Infinity) - Date.now());
  const deadline = performance.now() + duration;
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    if (closed || performance.now() >= deadline || requests >= maxRequests || controllers.size >= 4) {
      const category = controllers.size >= 4 ? 'temporary' : 'quota';
      response.writeHead(category === 'temporary' ? 503 : 403, {'content-type': 'application/json'}).end(JSON.stringify({category}));
      return;
    }
    requests += 1;
    const controller = new AbortController();
    controllers.add(controller);
    let timer = setTimeout(() => controller.abort(), Math.min(120_000, deadline - performance.now()));
    const progress = (event: unknown) => {
      const chunk = event as {choices?: {delta?: {content?: string; reasoning_content?: string; tool_calls?: {id?: string; function?: {name?: string; arguments?: string}}[]}; finish_reason?: string}[]};
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason || delta?.content || delta?.reasoning_content || delta?.tool_calls?.some((part) => part.id || part.function?.name || part.function?.arguments)) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), Math.min(60_000, deadline - performance.now()));
      }
    };
    response.on('close', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        response.writeHead(400).end();
        return;
      }
      const header = (name: string) => { const value = request.headers[`x-acc-${name}`]; return typeof value === 'string' && /^[a-zA-Z0-9_:/.-]{1,128}$/.test(value) ? value : undefined; };
      const result = await invoke(parsed.data, controller.signal, {requestId: header('requestid'), agentId: header('agentid'), attempt: Number(header('attempt')) || undefined});
      if (!parsed.data.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      response.setHeader('content-type', 'application/x-ndjson');
      for await (const event of result as AsyncIterable<unknown>) {
        if (controller.signal.aborted) break;
        progress(event);
        if (event && typeof event === 'object' && 'event_type' in event && event.event_type === 'error') {
          throw new Error('provider stream failed');
        }
        if (!response.write(`${JSON.stringify({event})}\n`)) {
          await once(response, 'drain', {signal: controller.signal});
        }
      }
      if (!controller.signal.aborted) response.end('{"done":true}\n');
      else response.destroy();
    } catch (error) {
      const root = rootError(error);
      const category = controller.signal.aborted ? 'timeout' : errorCategory(error);
      const safe = {category, ...(typeof root.status === 'number' ? {status: root.status} : {}), retryAfterMs: retryDelay(error, 0)};
      if (!response.headersSent) response.writeHead(502, {'content-type': 'application/json'}).end(JSON.stringify(safe));
      else if (!response.destroyed) response.end(JSON.stringify({error: safe}) + '\n');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  server.listen(0, options.bindHost ?? '0.0.0.0');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model relay did not bind a TCP port');
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(expiry);
    for (const controller of controllers) controller.abort();
    closePromise = new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closePromise;
  };
  const expiry = setTimeout(() => { void close(); }, Math.max(0, duration));
  return {port: address.port, path, close};
}

async function main(): Promise<void> {
  const lines = createInterface({input: process.stdin});
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.length > 16_384) throw new Error('invalid model relay initialization');
  const configuration = JSON.parse(first.value) as Parameters<typeof startModelRelay>[0];
  const relay = await startModelRelay(configuration);
  process.stdout.write(`${JSON.stringify({protocol: 1, port: relay.port, path: relay.path})}\n`);
  const stop = () => { void relay.close().then(() => { lines.close(); process.stdin.destroy(); }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  lines.once('close', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('model relay could not start; check the host runtime, model, and key\n');
    process.exitCode = 1;
    process.stdin.destroy();
  });
}
