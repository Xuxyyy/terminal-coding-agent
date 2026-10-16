import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {AgentEvent, BackgroundTaskInfo} from './host.js';
import {accHome, makeDir, writeJson} from './projects.js';
import {startCommand, type RunOptions, type RunningCommand, type SandboxResult} from './sandbox/run.js';
import type {SandboxMode} from './sandbox/mode.js';

export const FOREGROUND_TIMEOUT = 120_000;
export const BACKGROUND_TIMEOUT = 1_800_000;

type Task = {
  info: BackgroundTaskInfo;
  process: RunningCommand;
  done: Promise<void>;
  result?: SandboxResult;
  error?: Error;
  background: boolean;
  notified: boolean;
  stopReason?: string;
  timer?: NodeJS.Timeout;
};

export class BackgroundTasks {
  readonly owner = crypto.randomUUID();
  readonly directory: string;
  private tasks = new Map<string, Task>();
  private children = new Set<BackgroundTasks>();
  private notices: BackgroundTaskInfo[] = [];
  private listeners = new Set<() => void>();
  private closed = false;

  constructor(private options: {
    signal: AbortSignal;
    onEvent: (event: AgentEvent) => void;
    directory?: string;
  }) {
    this.directory = options.directory ?? path.resolve(accHome(), 'runs', crypto.randomUUID(), 'tasks');
  }

  fork(onEvent: (event: AgentEvent) => void): BackgroundTasks {
    if (this.closed) throw new Error('background task manager is closed');
    const child = new BackgroundTasks({...this.options, directory: this.directory, onEvent});
    this.children.add(child);
    return child;
  }

  private get(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task '${id}' for this agent`);
    return task;
  }

  private save(task: Task): void {
    writeJson(task.info.logPath.replace(/\.log$/, '.json'), task.info);
  }

  private notify(task: Task): void {
    if (!task.background || task.notified || task.info.status === 'running') return;
    task.notified = true;
    const info = {...task.info};
    if (!this.closed) this.notices.push(info);
    this.options.onEvent({type: 'background_task', action: 'completed', task: info});
    for (const listener of this.listeners) listener();
  }

  private background(task: Task, timeout: number): BackgroundTaskInfo {
    if (this.closed || this.options.signal.aborted) throw new DOMException('Run interrupted', 'AbortError');
    task.background = true;
    if (task.info.status === 'running') {
      task.timer = setTimeout(() => task.process.stop('timeout'), timeout);
    }
    this.save(task);
    this.options.onEvent({type: 'background_task', action: 'started', task: {...task.info}});
    this.notify(task);
    return {...task.info};
  }

  async run(options: RunOptions & {
    sandbox?: SandboxMode;
    command: string;
    description?: string;
    background: boolean;
    timeout?: number;
  }): Promise<{task: BackgroundTaskInfo; moved: boolean} | {result: SandboxResult}> {
    if (this.closed || this.options.signal.aborted) throw new DOMException('Run interrupted', 'AbortError');
    makeDir(this.directory);
    const id = crypto.randomUUID();
    const logPath = path.join(this.directory, `${id}.log`);
    const fd = fs.openSync(logPath, 'wx', 0o600);
    let characters = 0;
    let task: Task;
    let process: RunningCommand;
    try {
      process = startCommand({
        ...options,
        signal: this.options.signal,
        timeoutMs: null,
        captureOutput: false,
        onOutput(text) {
          fs.writeFileSync(fd, text);
          characters += text.length;
          task.info.characters = characters;
        },
      });
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(logPath, {force: true});
      throw error;
    }
    task = {
      info: {id, owner: this.owner, command: options.command, description: options.description,
        status: 'running', logPath, code: null, characters: 0},
      process, done: Promise.resolve(), background: false, notified: false,
    };
    this.tasks.set(id, task);
    const finish = (result?: SandboxResult, error?: Error) => {
      if (task.timer) clearTimeout(task.timer);
      task.result = result;
      task.error = error;
      task.info.characters = characters;
      task.info.code = result?.code ?? null;
      task.info.status = error
        ? /32 MiB output limit/.test(error.message) ? 'output_limit' : 'failed'
        : result?.interrupted ? 'stopped'
        : result?.timedOut ? 'timed_out'
        : result?.code === 0 ? 'completed' : 'failed';
      task.info.reason = error?.message ?? (result?.interrupted ? task.stopReason ?? 'run interrupted'
        : result?.timedOut ? 'background runtime limit reached' : undefined);
      try {
        fs.closeSync(fd);
        this.save(task);
      } catch (failure) {
        task.error = failure as Error;
        task.info.status = 'failed';
        task.info.reason = `could not save task evidence: ${(failure as Error).message}`;
      }
      this.notify(task);
    };
    task.done = process.result.then((result) => finish(result), (error: Error) => finish(undefined, error));
    try {
      this.save(task);
      await process.ready;
      if (this.closed || this.options.signal.aborted) throw new DOMException('Run interrupted', 'AbortError');
      if (options.background) return {task: this.background(task, options.timeout ?? BACKGROUND_TIMEOUT), moved: false};
      let timer: NodeJS.Timeout | undefined;
      const complete = await Promise.race([
        task.done.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), options.timeout ?? FOREGROUND_TIMEOUT); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!complete && task.info.status === 'running') {
        return {task: this.background(task, BACKGROUND_TIMEOUT), moved: true};
      }
      if (task.error) throw task.error;
      const text = await this.excerpt(task);
      return {result: {...task.result!, stdout: text, stderr: ''}};
    } catch (error) {
      if (task.info.status === 'running') {
        task.stopReason = 'command startup or tracking failed';
        process.stop();
      }
      await task.done;
      throw error;
    }
  }

  private async read(task: Task, offset: number, limit: number): Promise<string> {
    if (limit === 0) return '';
    const stream = fs.createReadStream(task.info.logPath, {encoding: 'utf8'});
    let position = 0;
    let output = '';
    try {
      for await (const chunk of stream) {
        const text = chunk as string;
        if (position + text.length > offset) {
          output += text.slice(Math.max(0, offset - position), Math.max(0, offset - position) + limit - output.length);
        }
        position += text.length;
        if (output.length >= limit) break;
      }
    } finally {
      stream.destroy();
    }
    return output;
  }

  private async excerpt(task: Task): Promise<string> {
    const length = task.info.characters;
    if (length <= 30_000) return this.read(task, 0, 30_000);
    return await this.read(task, 0, 10_000) + `\n... [truncated ${length - 30_000} chars]\n` +
      await this.read(task, length - 20_000, 20_000);
  }

  async output(id: string, offset = 0, limit = 30_000): Promise<{task: BackgroundTaskInfo; output: string; next_offset: number}> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30_000) {
      throw new Error('offset must be a nonnegative safe integer; limit must be an integer from 1 to 30000');
    }
    const task = this.get(id);
    const output = await this.read(task, offset, limit);
    return {task: {...task.info}, output, next_offset: offset + output.length};
  }

  async stop(id: string, reason = 'stopped by the agent'): Promise<BackgroundTaskInfo> {
    const task = this.get(id);
    if (task.info.status === 'running') {
      task.stopReason = reason;
      task.process.stop();
    }
    await task.done;
    return {...task.info};
  }

  drain(): BackgroundTaskInfo[] {
    return this.notices.splice(0);
  }

  hasPending(): boolean {
    return this.notices.length > 0 || [...this.tasks.values()].some((task) => task.background && task.info.status === 'running');
  }

  async wait(): Promise<void> {
    if (this.notices.length > 0 || !this.hasPending() || this.options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        this.listeners.delete(wake);
        this.options.signal.removeEventListener('abort', wake);
        resolve();
      };
      this.listeners.add(wake);
      this.options.signal.addEventListener('abort', wake, {once: true});
      if (this.notices.length > 0 || !this.hasPending() || this.options.signal.aborted) wake();
    });
  }

  async close(reason: string): Promise<BackgroundTaskInfo[]> {
    this.closed = true;
    const running = [...this.tasks.values()].filter((task) => task.info.status === 'running');
    const stopped = await Promise.all(running.map((task) => this.stop(task.info.id, reason)));
    await Promise.all([...this.children].map((child) => child.close(reason)));
    this.notices = [];
    for (const listener of this.listeners) listener();
    return stopped;
  }
}
