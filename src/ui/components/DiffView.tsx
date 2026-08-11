import {Box, Text} from 'ink';
import type {DiffPayload, DiffRow} from '../events.js';
import {theme} from '../theme.js';

function DiffLine({row}: {row: DiffRow}) {
  if (row.kind === 'gap') return <Text color={theme.muted}>{'       ⋯'}</Text>;
  const number = String(row.line ?? '').padStart(4);
  const mark = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ';
  const color = row.kind === 'add'
    ? theme.success
    : row.kind === 'remove'
      ? theme.error
      : theme.muted;
  return (
    <Text color={color}>
      {`  ${number} ${mark} ${row.text ?? ''}`}
    </Text>
  );
}

export function DiffView({diff}: {diff: DiffPayload}) {
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{diff.path}</Text>
      <Text color={theme.muted}>{'  '}{'─'.repeat(40)}</Text>
      {diff.rows.map((row, index) => (
        <DiffLine key={index} row={row} />
      ))}
      {diff.hidden ? (
        <Text color={theme.muted}>{`         … +${diff.hidden} more lines`}</Text>
      ) : null}
    </Box>
  );
}
