import type {ConfirmDecision, ConfirmRequest, Host, Usage} from './host.js';
import type {SessionStore} from './store.js';
import type {ToolOutput} from './tools/registry.js';
import {AgentMailbox, type AgentMail} from './agent-mailbox.js';
import {listSubagents} from './subagent-store.js';

type Job = {
  id: string; description: string; controller: AbortController; done: Promise<ToolOutput>;
  state: 'running' | 'waiting_permission' | 'stopping' | 'idle' | 'interrupted' | 'failed';
};

export class AgentRuntime {
  readonly mail: AgentMailbox;
  accountUsage?: (id: string, usage: Usage) => void;
  private jobs = new Map<string, Job>();
  private listeners = new Set<() => void>();
  private permissionTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failure?: unknown;
  private wakes = new Map<string, () => Promise<ToolOutput>>();

  constructor(readonly host: Host, readonly store?: SessionStore) {
    this.mail = new AgentMailbox(store);
    if (store) for (const meta of listSubagents(store)) {
      if (meta.background && meta.result && meta.assignmentId && meta.status !== 'running' && meta.status !== 'interrupted') {
        this.mail.send(meta.id, 'main', meta.result.text, 'result', `result-${meta.assignmentId}`, meta.result.usage);
      } else if (meta.status === 'interrupted') {
        this.mail.send(meta.id, 'main', 'Previous work was interrupted. Inspect saved outcomes before explicitly resuming; pending messages are retained.', 'interrupted', `interrupted-${meta.id}-${meta.updatedAt}`);
      }
    }
  }

  check(): void { if (this.failure) throw this.failure; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  list() {
    const saved = this.store ? listSubagents(this.store) : [];
    const entries = saved.map((meta) => ({
      agent_id: meta.id, description: meta.description, agent: meta.agent,
      status: this.jobs.get(meta.id)?.state ?? (meta.status === 'completed' ? 'idle' : meta.status),
      assignment_status: meta.status, updated_at: meta.updatedAt,
      pending_messages: this.mail.pending(meta.id).length,
    }));
    for (const job of this.jobs.values()) if (!entries.some((entry) => entry.agent_id === job.id)) {
      entries.push({agent_id: job.id, description: job.description, agent: undefined, status: job.state,
        assignment_status: job.state === 'idle' ? 'completed' : job.state === 'failed' ? 'failed' : job.state === 'interrupted' ? 'interrupted' : 'running',
        updated_at: '', pending_messages: this.mail.pending(job.id).length});
    }
    return entries;
  }

  has(id: string): boolean { return this.list().some((entry) => entry.agent_id === id); }
  running(id?: string): boolean {
    return [...this.jobs.values()].some((job) => (!id || job.id === id) && ['running', 'waiting_permission', 'stopping'].includes(job.state));
  }

  onIdle(id: string, wake: () => Promise<ToolOutput>): void { this.wakes.set(id, wake); }

  start(id: string, description: string, run: (signal: AbortSignal) => Promise<ToolOutput>, background: boolean, assignmentId: string): Promise<ToolOutput> {
    if (this.closed || this.host.signal.aborted) throw new Error('agent runtime is cancelled or closed');
    if (this.running(id)) throw new Error('agent already has active work; send a message instead');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.host.signal]);
    const job: Job = {id, description, controller, state: 'running', done: undefined!};
    this.jobs.set(id, job);
    job.done = Promise.resolve().then(() => run(signal)).catch((error): ToolOutput => ({text: `Error: ${(error as Error).message}`, failure: true, execution: 'uncertain'})).then((output) => {
      job.state = signal.aborted ? 'interrupted' : output.failure ? 'failed' : 'idle';
      if (background) {
        if (output.usage) this.accountUsage?.(`result-${assignmentId}`, output.usage);
        this.mail.send(id, 'main', output.text, 'result', `result-${assignmentId}`, output.usage);
      }
      if (job.state === 'idle' && this.mail.pending(id).length && !this.closed && !this.host.signal.aborted) {
        void this.wakes.get(id)?.().then((resumed) => {
          if (resumed.failure || resumed.text.startsWith('Error:')) this.send(id, 'main', `Queued messages need attention: ${resumed.text}`, 'attention');
        }).catch((error) => { this.failure = error; this.changed(); });
      }
      return output;
    }).finally(() => this.changed());
    job.done.catch((error) => {
      this.failure = error;
      job.state = 'failed';
      this.changed();
    });
    this.changed();
    return job.done;
  }

  send(from: string, to: string, text: string, kind: AgentMail['kind'] = 'message', id?: string): AgentMail {
    if (this.closed || this.host.signal.aborted) throw new Error('agent runtime is cancelled or closed');
    const event = this.mail.send(from, to, text, kind, id);
    this.changed();
    return event;
  }

  async waitForEvent(signal: AbortSignal): Promise<void> {
    this.check();
    if (this.mail.pending('main').length || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => { this.listeners.delete(check); signal.removeEventListener('abort', done); resolve(); };
      const check = () => { if (this.failure || this.mail.pending('main').length || signal.aborted) done(); };
      this.listeners.add(check);
      signal.addEventListener('abort', done, {once: true});
      check();
    });
    this.check();
  }

  async wait(ids: string[], timeout: number, signal: AbortSignal): Promise<AgentMail[]> {
    for (const id of ids) if (!this.has(id)) throw new Error(`unknown agent '${id}' in this parent session`);
    const pending = () => this.mail.pending('main').filter((event) => !ids.length || ids.includes(event.from));
    if (pending().length || !ids.some((id) => this.running(id)) && (ids.length > 0 || !this.running()) || timeout === 0 || signal.aborted) return pending();
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const done = () => { clearTimeout(timer); this.listeners.delete(check); signal.removeEventListener('abort', done); resolve(); };
      const check = () => { if (pending().length || !(ids.length ? ids.some((id) => this.running(id)) : this.running())) done(); };
      this.listeners.add(check);
      signal.addEventListener('abort', done, {once: true});
      if (Number.isFinite(timeout)) timer = setTimeout(done, timeout);
      check();
      if (signal.aborted) done();
    });
    return pending();
  }

  async stop(ids: string[]): Promise<void> {
    for (const id of ids) if (!this.has(id)) throw new Error(`unknown agent '${id}' in this parent session`);
    const jobs = ids.map((id) => this.jobs.get(id)).filter((job): job is Job => Boolean(job && this.running(job.id)));
    for (const job of jobs) { job.state = 'stopping'; job.controller.abort(); }
    this.changed();
    await Promise.allSettled(jobs.map((job) => job.done));
  }

  async confirm(request: ConfirmRequest, signal: AbortSignal, agentId: string): Promise<ConfirmDecision> {
    if (signal.aborted || this.closed || this.host.signal.aborted) return 'deny';
    const previous = this.permissionTail;
    let release!: () => void;
    this.permissionTail = new Promise<void>((resolve) => { release = resolve; });
    const job = this.jobs.get(agentId);
    let acquired = false;
    let cancel!: () => void;
    const cancelled = new Promise<'deny'>((resolve) => { cancel = () => resolve('deny'); });
    signal.addEventListener('abort', cancel, {once: true});
    try {
      if (job) {
        job.state = 'waiting_permission';
        this.send(agentId, 'main', `Permission required: ${request.command}`, 'attention');
      }
      if (signal.aborted) cancel();
      const turn = await Promise.race([previous.then(() => 'ready' as const), cancelled]);
      if (turn !== 'ready' || signal.aborted || this.closed) return 'deny';
      acquired = true;
      return await Promise.race([this.host.confirm(request, signal), cancelled]);
    } finally {
      signal.removeEventListener('abort', cancel);
      if (job && job.state === 'waiting_permission') job.state = signal.aborted ? 'stopping' : 'running';
      if (acquired) release();
      else void previous.then(release, release);
      this.changed();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) if (this.running(job.id)) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }
}
