import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import {
  diffSummary,
  failureOutput,
  formatArgs,
  noticeText,
  resultCount,
  resultStatus,
  splitsCommand,
  toolDescription,
  writeSummary,
} from '../../events.js';
import type {DiffPayload} from '../../events.js';
import {theme} from '../../theme.js';
import {DiffView} from '../DiffView.js';

function statusNode(
  name: string,
  result: string | null,
  diff: DiffPayload | null,
  awaitingApproval: boolean,
): ReactNode {
  if (result === null) return awaitingApproval ? 'waiting for approval…' : 'running…';
  const status = resultStatus(name, result);
  if (status !== 'done' && status !== 'exit 0') return status;
  if (diff && diffSummary(diff)) {
    return (
      <>
        {diff.added ? (
          <Text color={theme.success}>{`+${diff.added}`}</Text>
        ) : null}
        {diff.added && diff.removed ? ' ' : null}
        {diff.removed ? (
          <Text color={theme.error}>{`−${diff.removed}`}</Text>
        ) : null}
      </>
    );
  }
  return writeSummary(name, result) ?? resultCount(name, result) ?? null;
}

function TreeLines({text}: {text: string}) {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column" marginLeft={4}>
      {lines.map((line, index) => (
        <Text key={index} color={theme.muted}>
          {index === lines.length - 1 ? '└─ ' : '├─ '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function ToolEntry({
  name,
  args,
  result,
  diff,
  workspaceRoot,
  awaitingApproval = false,
}: {
  name: string;
  args: unknown;
  result: string | null;
  diff: DiffPayload | null;
  workspaceRoot?: string;
  awaitingApproval?: boolean;
}) {
  const description = toolDescription(name, args);
  const status = statusNode(name, result, diff, awaitingApproval);
  const summaryArgs = formatArgs(name, args, workspaceRoot);
  const below = summaryArgs !== '' && splitsCommand(name, description);
  const inline = description || (below ? '' : summaryArgs);
  const failure = result === null ? null : failureOutput(name, result);
  const notice = result === null ? null : noticeText(result);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.foreground}>
        <Text color={theme.tool}>{' • '}</Text>
        <Text bold>{name}</Text>
        {inline ? <Text color={theme.muted}> {inline}</Text> : null}
        {status ? (
          <Text color={theme.muted}>
            {' — '}
            {status}
          </Text>
        ) : null}
      </Text>
      {below ? <TreeLines text={summaryArgs} /> : null}
      {notice ? (
        <Box marginLeft={3}>
          <Text color={theme.warning}>{'⚠ '}{notice}</Text>
        </Box>
      ) : null}
      {diff ? (
        <Box marginLeft={3}>
          <DiffView diff={diff} />
        </Box>
      ) : null}
      {failure ? (
        <Box marginLeft={3}>
          <Text color={theme.muted}>{failure}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
