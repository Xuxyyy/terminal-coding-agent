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
import type {Item, Phase, ReadyInfo} from './events.js';

export const PERMISSION_LABEL = 'bash asks, edits allowed';

export type Agent = {
  committed: Item[];
  streamText: string;
  phase: Phase;
  generation: number;
  send: (task: string) => boolean;
  respond: (decision: ConfirmDecision) => void;
  interrupt: () => void;
  clear: () => void;
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

  const flushText = () => {
    const text = liveTextRef.current;
    liveTextRef.current = '';
    setStreamText('');
    if (text) setCommitted((prev) => [...prev, {kind: 'text', text}]);
  };

  const send = (task: string): boolean => {
    if (phase.kind !== 'idle') return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    addTask(session, task);
    setCommitted((prev) => [...prev, {kind: 'task', text: task}]);
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
        setCommitted((prev) => [...prev, {kind: 'event', event}]);
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

    void runAgent(session, choice, host).finally(() => {
      flushText();
      resolveConfirmRef.current = null;
      if (controller.signal.aborted) {
        setCommitted((prev) => [...prev, {kind: 'notice', text: '⏹ stopped'}]);
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
    liveTextRef.current = '';
    setStreamText('');
    setGeneration((current) => current + 1);
    setCommitted([header(), {kind: 'notice', text: 'context cleared'}]);
  };

  const context = () => {
    if (phase.kind !== 'idle') return;
    const status = contextStatus(session);
    setCommitted((prev) => [...prev, {kind: 'context', ...status}]);
  };

  const shutdown = () => {
    controllerRef.current?.abort();
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
    context,
    shutdown,
  };
}
