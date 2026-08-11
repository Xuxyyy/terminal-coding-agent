import {Box, Text} from 'ink';
import {theme} from '../theme.js';
import {Spinner} from './Spinner.js';

export function Activity({status}: {status: string}) {
  return (
    <Box>
      <Spinner />
      <Text color={theme.activity}> {status}</Text>
    </Box>
  );
}
