import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export function ModelDivider({label}: {label: string}) {
  const dividerWidth = 72;
  const maxLabelWidth = dividerWidth - 4;
  const displayLabel =
    label.length > maxLabelWidth
      ? `${label.slice(0, maxLabelWidth - 1)}…`
      : label;
  const lineWidth = dividerWidth - displayLabel.length - 2;
  const leftWidth = Math.floor(lineWidth / 2);
  const rightWidth = lineWidth - leftWidth;
  return (
    <Box marginTop={1}>
      <Text color={theme.foreground}>
        <Text color={theme.muted}>{'─'.repeat(leftWidth)}</Text>
        <Text color={theme.foreground}>{` ${displayLabel} `}</Text>
        <Text color={theme.muted}>{'─'.repeat(rightWidth)}</Text>
      </Text>
    </Box>
  );
}
