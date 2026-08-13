import {useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import type {ModelChoice} from '../core/client.js';
import {useAgent} from './agent.js';
import {statusFor} from './events.js';
import {streamRowBudget, tailLines} from './stream-view.js';
import {appendCommandHistory, loadCommandHistory} from './command-history.js';
import {Activity} from './components/Activity.js';
import {CommandInput, commandMatches} from './components/CommandInput.js';
import {Confirm} from './components/Confirm.js';
import {Markdown} from './components/Markdown.js';
import {Picker} from './components/Picker.js';
import {SessionPicker} from './components/SessionPicker.js';
import {rewindLine} from './rewind.js';
import {sessionRows} from './sessions.js';
import {HistoryList} from './components/history/HistoryList.js';
import {theme} from './theme.js';

export function App({
  workspaceRoot,
  choice,
  onCleanExit,
}: {
  workspaceRoot: string;
  choice: ModelChoice;
  onCleanExit: () => void;
}) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const {
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
    pickRewind,
    checkpoints,
    rewind,
    context,
    compact,
    shutdown,
  } = useAgent(workspaceRoot, choice);
  const [input, setInput] = useState('');
  const [commandHistory, setCommandHistory] = useState(loadCommandHistory);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [closing, setClosing] = useState(false);
  const inputShown = phase.kind === 'idle' && !closing;
  const menuOpen = commandMatches(input).length > 0;
  const visibleStream = useMemo(
    () => tailLines(streamText, streamRowBudget(stdout.rows), stdout.columns),
    [streamText, stdout.columns, stdout.rows],
  );
  const rows = useMemo(
    () => (phase.kind === 'picking' ? sessionRows(workspaceRoot) : []),
    [phase.kind, workspaceRoot],
  );
  const rewindable = phase.kind === 'rewinding' ? checkpoints() : [];

  const submit = (value: string) => {
    const command = value.trim();
    if (!command) return;
    appendCommandHistory(command);
    setCommandHistory((current) => [...current, command]);
    setHistoryIndex(null);
    setDraft('');
    if (command === 'exit' || command === 'quit' || command === 'q') {
      setClosing(true);
      shutdown();
      return;
    }
    if (command === '/clear') {
      clear();
      setInput('');
      return;
    }
    if (command === '/resume') {
      pick();
      setInput('');
      return;
    }
    if (command === '/rewind') {
      pickRewind();
      setInput('');
      return;
    }
    if (command === '/context') {
      context();
      setInput('');
      return;
    }
    if (command === '/compact') {
      compact();
      setInput('');
      return;
    }
    if (send(command)) setInput('');
  };

  useInput(
    (_input, key) => {
      if (key.escape) interrupt();
    },
    {isActive: phase.kind === 'busy'},
  );

  useInput(
    (_input, key) => {
      if (!key.upArrow && !key.downArrow) return;
      if (!commandHistory.length) return;
      if (key.upArrow) {
        const next =
          historyIndex === null
            ? commandHistory.length - 1
            : Math.max(0, historyIndex - 1);
        if (historyIndex === null) setDraft(input);
        setHistoryIndex(next);
        setInput(commandHistory[next]!);
      } else if (historyIndex !== null) {
        const next = historyIndex + 1;
        if (next >= commandHistory.length) {
          setHistoryIndex(null);
          setInput(draft);
        } else {
          setHistoryIndex(next);
          setInput(commandHistory[next]!);
        }
      }
    },
    {isActive: inputShown && !menuOpen},
  );

  useEffect(() => {
    if (phase.kind !== 'closed') return;
    if (closing) {
      onCleanExit();
      return;
    }
    exit();
  }, [closing, exit, onCleanExit, phase.kind]);

  return (
    <Box flexDirection="column">
      <HistoryList
        key={generation}
        items={committed}
        awaitingApproval={phase.kind === 'confirming'}
      />
      <Box flexDirection="column" marginTop={1}>
        {visibleStream ? <Markdown text={visibleStream} /> : null}
        {phase.kind === 'confirming' ? (
          <Confirm request={phase.request} onRespond={respond} />
        ) : phase.kind === 'picking' ? (
          <SessionPicker rows={rows} onPick={resume} onCancel={cancelPick} />
        ) : phase.kind === 'rewinding' ? (
          <Picker
            title="Rewind to before a message"
            rows={rewindable}
            hint="↑↓ to move · enter to rewind · esc to cancel"
            empty="Nothing to rewind yet."
            renderRow={rewindLine}
            onPick={rewind}
            onCancel={cancelPick}
            initial={rewindable.length - 1}
          />
        ) : phase.kind === 'busy' ? (
          <Box flexDirection="column">
            <Activity status={phase.label ?? statusFor(streamText, committed)} />
            <Text color={theme.muted}>esc to stop</Text>
          </Box>
        ) : inputShown ? (
          <CommandInput
            value={input}
            onChange={(value) => {
              setInput(value);
              if (historyIndex !== null) setHistoryIndex(null);
            }}
            onSubmit={submit}
          />
        ) : closing && phase.kind !== 'closed' ? (
          <Activity status="Closing…" />
        ) : null}
      </Box>
    </Box>
  );
}
