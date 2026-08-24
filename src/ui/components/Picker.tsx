import {useState} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import type {RowParts} from '../events.js';
import {theme} from '../theme.js';

const VISIBLE = 5;
const MAX_WIDTH = 80;

export function windowStart(selected: number, count: number): number {
  return Math.max(0, Math.min(selected - VISIBLE + 1, count - VISIBLE));
}

export function Picker<Row extends {id: string}>({
  title,
  rows,
  hint,
  empty,
  renderRow,
  onPick,
  onCancel,
  initial = 0,
  disabled = () => false,
  disabledHint,
}: {
  title: string;
  rows: Row[];
  hint: string;
  empty: string;
  renderRow: (row: Row, active: boolean, width: number) => string | RowParts;
  onPick: (id: Row['id']) => void;
  onCancel: () => void;
  initial?: number;
  disabled?: (row: Row) => boolean;
  disabledHint?: (row: Row) => string;
}) {
  const [selected, setSelected] = useState(
    Math.max(0, Math.min(initial, rows.length - 1)),
  );
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
      const row = rows[selected]!;
      if (!disabled(row)) onPick(row.id);
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
        <Text color={theme.foreground}>{empty}</Text>
        <Text color={theme.muted}>any key to go back</Text>
      </Box>
    );
  }

  const start = windowStart(selected, rows.length);
  const shown = rows.slice(start, start + VISIBLE);
  const here = rows[selected];
  const blockedHint =
    here && disabled(here) && disabledHint ? disabledHint(here) : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text bold color={theme.foreground}>{title}</Text>
      {shown.map((row, index) => {
        const active = start + index === selected;
        const out = disabled(row);
        const rendered = renderRow(row, active, width);
        const {head, tail} =
          typeof rendered === 'string' ? {head: rendered, tail: ''} : rendered;
        return (
          <Text
            key={row.id}
            color={active && !out ? theme.foreground : theme.muted}
            backgroundColor={active && !out ? theme.surface : undefined}
          >
            <Text bold={active && !out}>{head}</Text>
            {tail}
          </Text>
        );
      })}
      <Text color={theme.muted}>
        {rows.length > VISIBLE ? `${selected + 1}/${rows.length} · ` : ''}
        {blockedHint ?? hint}
      </Text>
    </Box>
  );
}
