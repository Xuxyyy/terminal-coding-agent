import {Box, Text} from 'ink';
import {
  compactReadout,
  contextReadout,
  fatalErrorLines,
  formatResult,
  planSummary,
  sandboxRetryMessage,
  type CompactResult,
  type FatalErrorDetail,
  type Item,
  type SandboxRetryDetail,
} from '../events.js';
import {theme} from '../theme.js';
import {Markdown} from './Markdown.js';
import {ModelDivider} from './ModelDivider.js';
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
  if (item.kind === 'plan_summary') {
    const steps = item.plan.items ?? [];
    const done = steps.filter((step) => step.status === 'done').length;
    const complete = steps.length > 0 && done === steps.length;
    return (
      <Text color={complete ? theme.success : theme.muted}>
        {planSummary(item.plan)}
      </Text>
    );
  }
  const {type, detail} = item.event;
  switch (type) {
    case 'task':
      return (
        <Box marginTop={1}>
          <Text bold backgroundColor={theme.surface}>
            <Text color={theme.muted}>{' ❯ '}</Text>
            <Text color={theme.foreground}>{`${String(detail)} `}</Text>
          </Text>
        </Box>
      );
    case 'tool': {
      const [name] = detail as [string, unknown];
      return (
        <Text color={theme.tool}>
          {'⚙ '}
          {name}
        </Text>
      );
    }
    case 'result': {
      const [name, result] = detail as [string, string];
      return (
        <Box marginLeft={2}>
          <Text color={theme.muted}>{formatResult(name, result)}</Text>
        </Box>
      );
    }
    case 'error':
      return <Text color={theme.error}>{'✖ '}{String(detail)}</Text>;
    case 'warning':
      return <Text color={theme.warning}>{'⚠ '}{String(detail)}</Text>;
    case 'sandbox_retry':
      return (
        <Text color={theme.warning}>
          {'⟳ '}
          {sandboxRetryMessage(detail as SandboxRetryDetail)}
        </Text>
      );
    case 'fatal_error': {
      const lines = fatalErrorLines(detail as FatalErrorDetail);
      return (
        <Box flexDirection="column">
          <Text bold color={theme.error}>{`✖ ${lines[0]}`}</Text>
          {lines.slice(1).map((line) => (
            <Text key={line} color={theme.error}>{line}</Text>
          ))}
        </Box>
      );
    }
    case 'skill':
      return <Text color={theme.accent}>★ skill loaded: {String(detail)}</Text>;
    case 'retry': {
      const [attempt, total, reason] = detail as [number, number, string];
      return (
        <Text color={theme.warning}>
          {`⟳ retrying after API error (${attempt}/${total}): ${reason}`}
        </Text>
      );
    }
    case 'interrupted':
      return <Text color={theme.muted}>⏹ stopped</Text>;
    case 'cleared':
      return <Text color={theme.muted}>context cleared</Text>;
    case 'context_usage': {
      const {used, budget} = detail as {used: number; budget: number};
      const {line, bar} = contextReadout(used, budget);
      return (
        <Box flexDirection="column">
          <Text color={theme.foreground}>{line}</Text>
          <Text color={theme.muted}>{`[${bar}]`}</Text>
        </Box>
      );
    }
    case 'context_compact': {
      const [before, after] = detail as [number, number];
      return (
        <Text color={theme.muted}>
          {compactReadout(before, after, true)}
        </Text>
      );
    }
    case 'context_trim': {
      const [before, after] = detail as [number, number];
      return (
        <Text color={theme.muted}>
          {`context trimmed: ${before} → ${after} messages`}
        </Text>
      );
    }
    case 'compact_result': {
      const {changed, before, after} = detail as CompactResult;
      return (
        <Text color={theme.muted}>
          {changed ? compactReadout(before, after) : 'nothing to compact'}
        </Text>
      );
    }
    case 'compact_error':
      return <Text color={theme.error}>compaction failed: {String(detail)}</Text>;
    case 'auto_compact_result': {
      const {changed, before, after} = detail as CompactResult;
      return changed ? (
        <Text color={theme.muted}>
          {compactReadout(before, after, true)}
        </Text>
      ) : null;
    }
    case 'auto_compact_error':
      return <Text color={theme.error}>auto-compaction failed: {String(detail)}</Text>;
    case 'transcript_saved': {
      const {path} = detail as {path: string};
      return <Text color={theme.muted}>transcript: {path}</Text>;
    }
    case 'model_changed': {
      const {label} = detail as {id: string; label: string};
      return <ModelDivider label={label} />;
    }
    case 'model_error': {
      const {message, currentLabel} = detail as {
        message: string;
        current: string;
        currentLabel: string;
      };
      return (
        <Box flexDirection="column">
          <Text color={theme.error}>{message}</Text>
          <Text color={theme.muted}>staying on {currentLabel}</Text>
        </Box>
      );
    }
    case 'permission_changed': {
      const {label} = detail as {id: string; label: string};
      return <Text color={theme.muted}>permission mode changed to {label}</Text>;
    }
    case 'permission_error': {
      const {message} = detail as {message: string};
      return <Text color={theme.error}>permission change failed: {message}</Text>;
    }
    default:
      return <Text color={theme.muted}>{'['}{type}{']'}</Text>;
  }
}
