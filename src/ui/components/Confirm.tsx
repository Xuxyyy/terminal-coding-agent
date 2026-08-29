import {Box, Text, useInput} from 'ink';
import {confirmChoices, confirmDecisionForKey} from '../confirm.js';
import type {ConfirmDecision, ConfirmRequest} from '../events.js';
import {theme} from '../theme.js';

const KEY_COLORS: Record<ConfirmDecision, string> = {
  once: theme.success,
  session: theme.success,
  deny: theme.error,
};

export function Confirm({
  request,
  onRespond,
  onStop,
}: {
  request: ConfirmRequest;
  onRespond: (decision: ConfirmDecision) => void;
  onStop: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) {
      onStop();
      return;
    }
    const decision = confirmDecisionForKey(input, request.suppressible);
    if (decision) {
      onRespond(decision);
    }
  });

  const choices = confirmChoices(request.suppressible);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>⚠ Command approval required</Text>
      <Text color={theme.foreground}>{request.command}</Text>
      <Text color={theme.muted}>{request.reason}</Text>
      <Text color={theme.foreground}>
        {choices.map((choice, index) => (
          <Text key={choice.key}>
            {index > 0 ? ' · ' : ''}
            <Text color={KEY_COLORS[choice.decision]}>{choice.key}</Text>
            {` ${choice.label}`}
          </Text>
        ))}
      </Text>
      <Text color={theme.muted}>esc to stop the turn</Text>
    </Box>
  );
}
