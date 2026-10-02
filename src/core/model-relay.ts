import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {geminiInvoke, type Invoke} from './gemini.js';
import {JUDGE_MODELS, MODELS} from './models.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const requestSchema = z.object({
  model: z.string(),
  store: z.literal(false),
  stream: z.boolean(),
  input: z.array(z.record(z.unknown())),
  system_instruction: z.string().optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }).strict()).optional(),
  generation_config: z.object({max_output_tokens: z.number().int().min(1).max(32_000)}).strict(),
}).strict();

export type ModelRelay = {
  port: number;
  path: string;
  close(): Promise<void>;
};

// A trial capability permits bounded model use, never retrieval of the key or
// arbitrary forwarding to an address supplied by the task.
export async function startModelRelay(options: {
  apiKey: string;
  model: string;
  maxSeconds: number;
  maxRequests?: number;
  bindHost?: string;
  invoke?: Invoke;
}): Promise<ModelRelay> {
  const info = MODELS[options.model];
  if (!info || info.provider !== 'gemini') throw new Error('model relay requires a model supported by this ACC runtime');
  if (!options.apiKey) throw new Error('model relay requires a provider key on the host');
  if (!Number.isInteger(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86_400) {
    throw new Error('model relay duration must be between 1 and 86400 seconds');
  }
  const maxRequests = options.maxRequests ?? 128;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1024) {
    throw new Error('model relay request limit must be between 1 and 1024');
  }
  const allowedModels = new Set([options.model, JUDGE_MODELS[info.provider]]);
  const path = `/${randomBytes(32).toString('hex')}/interactions`;
  const invoke = options.invoke ?? geminiInvoke(options.apiKey);
  const controllers = new Set<AbortController>();
  let requests = 0;
  let closed = false;
  const deadline = Date.now() + options.maxSeconds * 1000;
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    if (closed || Date.now() >= deadline || requests >= maxRequests || controllers.size >= 4) {
      response.writeHead(429).end();
      return;
    }
    // Count attempts too, so malformed requests cannot bypass the trial quota.
    requests += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.min(120_000, deadline - Date.now()));
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
      if (!parsed.success || !allowedModels.has(parsed.data.model)) {
        response.writeHead(400).end();
        return;
      }
      const result = await invoke(parsed.data, controller.signal);
      if (!parsed.data.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      response.setHeader('content-type', 'application/x-ndjson');
      for await (const event of result as AsyncIterable<unknown>) {
        if (controller.signal.aborted) break;
        if (event && typeof event === 'object' && 'event_type' in event && event.event_type === 'error') {
          throw new Error('provider stream failed');
        }
        if (!response.write(`${JSON.stringify({event})}\n`)) {
          await once(response, 'drain', {signal: controller.signal});
        }
      }
      if (!controller.signal.aborted) response.end('{"done":true}\n');
      else response.destroy();
    } catch {
      // SDK errors may include request details. Never forward their text.
      if (!response.headersSent) response.writeHead(502).end();
      else if (!response.destroyed) response.end('{"error":true}\n');
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
  const expiry = setTimeout(() => { void close(); }, options.maxSeconds * 1000);
  return {port: address.port, path, close};
}

async function main(): Promise<void> {
  // Python adapters send initialization over stdin, never argv, files, or the
  // environment of a container. EOF also closes the relay if the parent dies.
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
