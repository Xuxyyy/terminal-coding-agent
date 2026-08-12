import {useState} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {rowLine, type SessionRow} from '../sessions.js';
import {theme} from '../theme.js';

const VISIBLE = 5;
const MAX_WIDTH = 80;

export function windowStart(selected: number, count: number): number {
  return Math.max(0, Math.min(selected - VISIBLE + 1, count - VISIBLE));
}

export function SessionPicker({
  rows,
  onPick,
  onCancel,
}: {
  rows: SessionRow[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const {stdout} = useStdout();
  const width = Math.max(24, Math.min((stdout.columns ?? 80) - 6, MAX_WIDTH));

  useInput((_input, key) => {
    if (key.escape || rows.length === 0) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
    } else if (key.downArrow) {
      setSelected((current) => Math.min(rows.length - 1, current + 1));
    } else if (key.return) {
      onPick(rows[selected]!.id);
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
        <Text color={theme.foreground}>No past conversations in this folder yet.</Text>
        <Text color={theme.muted}>any key to go back</Text>
      </Box>
    );
  }

  const start = windowStart(selected, rows.length);
  const shown = rows.slice(start, start + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold color={theme.foreground}>Reopen a conversation</Text>
      {shown.map((row, index) => {
        const active = start + index === selected;
        return (
          <Text
            key={row.id}
            bold={active}
            color={active ? theme.foreground : theme.muted}
            backgroundColor={active ? theme.surface : undefined}
          >
            {rowLine(row, active, width)}
          </Text>
        );
      })}
      <Text color={theme.muted}>
        {rows.length > VISIBLE ? `${selected + 1}/${rows.length} · ` : ''}
        ↑↓ to move · enter to open · esc to cancel
      </Text>
    </Box>
  );
}
