import {Box, Text} from 'ink';
import {contextReadout, type Item} from '../events.js';
import {theme} from '../theme.js';
import {Markdown} from './Markdown.js';
import {Welcome} from './Welcome.js';

export function Entry({item}: {item: Item}) {
  if (item.kind === 'header') {
    return <Welcome workspaceRoot={item.workspaceRoot} ready={item.ready} />;
  }
  if (item.kind === 'text') {
    return (
      <Box marginTop={1}>
        <Text color={theme.foreground}>{' • '}</Text>
        <Box flexDirection="column">
          <Markdown text={item.text} />
        </Box>
      </Box>
    );
  }
  if (item.kind === 'task') {
    return (
      <Box marginTop={1}>
        <Text bold backgroundColor={theme.surface}>
          <Text color={theme.muted}>{' ❯ '}</Text>
          <Text color={theme.foreground}>{`${item.text} `}</Text>
        </Text>
      </Box>
    );
  }
  if (item.kind === 'notice') {
    return <Text color={theme.muted}>{item.text}</Text>;
  }
  if (item.kind === 'context') {
    const {line, bar, parts} = contextReadout(item);
    return (
      <Box flexDirection="column">
        <Text color={theme.foreground}>{line}</Text>
        <Text color={theme.muted}>{`[${bar}]`}</Text>
        {parts.map((part) => (
          <Text key={part} color={theme.muted}>{`  ${part}`}</Text>
        ))}
      </Box>
    );
  }
  if (item.event.type === 'error') {
    return (
      <Text color={theme.error}>
        {'✖ '}
        {item.event.message}
      </Text>
    );
  }
  return null;
}
