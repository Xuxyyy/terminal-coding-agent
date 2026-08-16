import {Box, Text, useInput} from 'ink';
import type {RewindFile} from '../events.js';
import {theme} from '../theme.js';

export const SHELL_CAVEAT =
  'files changed by a shell command or by you are not restored';

export const DELETED_MARK = '(deleted — it did not exist yet)';

export const SHOWN_FILES = 10;

export function rewindHeading(files: RewindFile[]): string {
  return `${files.length} file${files.length === 1 ? '' : 's'} will be restored:`;
}

export function rewindFileLines(files: RewindFile[]): string[] {
  const shown = files
    .slice(0, SHOWN_FILES)
    .map((file) => (file.deleted ? `${file.path}   ${DELETED_MARK}` : file.path));
  const more = files.length - shown.length;
  return more > 0 ? [...shown, `… and ${more} more`] : shown;
}

export function RewindConfirm({
  title,
  files,
  onConfirm,
  onCancel,
}: {
  title: string;
  files: RewindFile[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) onConfirm();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>{`rewind to before "${title}"`}</Text>
      <Text color={theme.foreground}>{rewindHeading(files)}</Text>
      {rewindFileLines(files).map((line) => (
        <Text key={line} color={theme.foreground}>{`  ${line}`}</Text>
      ))}
      <Text color={theme.muted}>{SHELL_CAVEAT}</Text>
      <Text color={theme.foreground}>
        <Text color={theme.success}>enter</Text>
        {' to rewind · '}
        <Text color={theme.error}>esc</Text>
        {' to cancel'}
      </Text>
    </Box>
  );
}
