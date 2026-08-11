import {Box, Text} from 'ink';
import type {ReadyInfo} from '../events.js';
import {theme} from '../theme.js';
import {ModelDivider} from './ModelDivider.js';

export function Welcome({
  workspaceRoot,
  ready,
}: {
  workspaceRoot: string;
  ready?: ReadyInfo;
}) {
  const sandbox = ready
    ? ready.sandbox
      ? 'sandbox: on'
      : 'sandbox: off'
    : 'starting bridge…';

  return (
    <Box flexDirection="column">
      <Text bold color={theme.foreground}>
        Agentic Coding CLI
      </Text>
      <Text color={theme.muted}>workspace: {workspaceRoot}</Text>
      <Text color={theme.muted}>{sandbox}</Text>
      {ready ? (
        <Text color={theme.muted}>permissions: {ready.permission.label}</Text>
      ) : null}
      {ready ? <ModelDivider label={ready.model.label} /> : null}
    </Box>
  );
}
