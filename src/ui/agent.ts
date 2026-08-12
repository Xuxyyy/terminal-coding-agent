import {useRef, useState} from 'react';
import type {ModelChoice} from '../core/client.js';
import type {ConfirmDecision, Host} from '../core/host.js';
import {runAgent} from '../core/loop.js';
import {systemPrompt} from '../core/prompt.js';
import {
  addTask,
  clearSession,
  contextStatus,
  createSession,
  type Session,
} from '../core/session.js';
import {openSession, startSession, type SessionStore} from '../core/store.js';
import type {Item, Phase, ReadyInfo} from './events.js';
import {restoreView} from './restore.js';

export const PERMISSION_LABEL = 'asks before anything git cannot undo';

export type Agent = {
  committed: Item[];
  streamText: string;
  phase: Phase;
  generation: number;
  send: (task: string) => boolean;
  respond: (decision: ConfirmDecision) => void;
  interrupt: () => void;
  clear: () => void;
  pick: () => void;
  cancelPick: () => void;
  resume: (id: string) => void;
  context: () => void;
  shutdown: () => void;
};

function readyInfo(workspaceRoot: string, choice: ModelChoice): ReadyInfo {
  return {
    workspace: workspaceRoot,
    model: {id: choice.model, label: choice.label},
    permission: {id: 'default', label: PERMISSION_LABEL},
  };
}

export function useAgent(workspaceRoot: string, choice: ModelChoice): Agent {
  const header = (): Item => ({
    kind: 'header',
    workspaceRoot,
    ready: readyInfo(workspaceRoot, choice),
  });
  const [committed, setCommitted] = useState<Item[]>(() => [header()]);
  const [streamText, setStreamText] = useState('');
  const [phase, setPhase] = useState<Phase>({kind: 'idle'});
  const [generation, setGeneration] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  const storeRef = useRef<SessionStore | null | undefined>(undefined);
  const liveTextRef = useRef('');
  const controllerRef = useRef<AbortController | null>(null);
  const resolveConfirmRef = useRef<((d: ConfirmDecision) => void) | null>(null);

  if (sessionRef.current === null) {
    sessionRef.current = createSession(
      workspaceRoot,
      systemPrompt(workspaceRoot),
      choice.contextWindow,
    );
  }
  const session = sessionRef.current;

  const openStore = (): SessionStore | null => {
    if (storeRef.current === undefined) {
      try {
        storeRef.current = startSession(workspaceRoot);
      } catch {
        storeRef.current = null;
      }
    }
    return storeRef.current;
  };

  const commit = (items: Item[]) => {
    setCommitted((prev) => [...prev, ...items]);
    try {
      storeRef.current?.appendView(items);
    } catch {}
  };

  const flushText = () => {
    const text = liveTextRef.current;
    liveTextRef.current = '';
    setStreamText('');
    if (text) commit([{kind: 'text', text}]);
  };

  const send = (task: string): boolean => {
    if (phase.kind !== 'idle') return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    openStore();
    addTask(session, task);
    commit([{kind: 'task', text: task}]);
    setPhase({kind: 'busy'});

    const host: Host = {
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'text_delta') {
          liveTextRef.current += event.text;
          setStreamText(liveTextRef.current);
          return;
        }
        if (event.type === 'turn_end') {
          flushText();
          return;
        }
        flushText();
        commit([{kind: 'event', event}]);
      },
      confirm(request) {
        setPhase({kind: 'confirming', request});
        return new Promise<ConfirmDecision>((resolve) => {
          resolveConfirmRef.current = (decision) => {
            resolveConfirmRef.current = null;
            setPhase({kind: 'busy'});
            resolve(decision);
          };
        });
      },
    };

    const store = storeRef.current ?? undefined;
    void runAgent(session, choice, host, undefined, store).finally(() => {
      flushText();
      resolveConfirmRef.current = null;
      if (controller.signal.aborted) {
        commit([{kind: 'notice', text: '⏹ stopped'}]);
      }
      controllerRef.current = null;
      setPhase({kind: 'idle'});
    });
    return true;
  };

  const respond = (decision: ConfirmDecision) => {
    resolveConfirmRef.current?.(decision);
  };

  const interrupt = () => {
    controllerRef.current?.abort();
  };

  const clear = () => {
    if (phase.kind !== 'idle') return;
    clearSession(session);
    try {
      storeRef.current?.close();
    } catch {}
    storeRef.current = undefined;
    liveTextRef.current = '';
    setStreamText('');
    setGeneration((current) => current + 1);
    setCommitted([header(), {kind: 'notice', text: 'context cleared'}]);
  };

  const pick = () => {
    if (phase.kind !== 'idle') return;
    setPhase({kind: 'picking'});
  };

  const cancelPick = () => {
    if (phase.kind !== 'picking') return;
    setPhase({kind: 'idle'});
  };

  const resume = (id: string) => {
    if (phase.kind !== 'picking') return;
    setPhase({kind: 'idle'});
    let opened: ReturnType<typeof openSession>;
    try {
      opened = openSession(workspaceRoot, id);
    } catch (error) {
      commit([{kind: 'notice', text: `could not reopen: ${String(error)}`}]);
      return;
    }
    try {
      storeRef.current?.close();
    } catch {}
    storeRef.current = opened.store;
    clearSession(session);
    for (const message of opened.stored.messages) {
      if (message.role !== 'system') session.messages.push(message);
    }
    opened.store.seed(session.messages);
    session.usage = {...opened.stored.meta.usage};
    liveTextRef.current = '';
    setStreamText('');
    setGeneration((current) => current + 1);
    setCommitted([header(), ...restoreView(opened.stored)]);
  };

  const context = () => {
    if (phase.kind !== 'idle') return;
    const status = contextStatus(session);
    commit([{kind: 'context', ...status}]);
  };

  const shutdown = () => {
    controllerRef.current?.abort();
    try {
      storeRef.current?.close();
    } catch {
      storeRef.current = null;
    }
    setPhase({kind: 'closed'});
  };

  return {
    committed,
    streamText,
    phase,
    generation,
    send,
    respond,
    interrupt,
    clear,
    pick,
    cancelPick,
    resume,
    context,
    shutdown,
  };
}
