import {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {theme} from '../theme.js';

const COMMANDS = [
  {value: '/context', description: 'show token usage'},
  {value: '/clear', description: 'clear the conversation'},
  {value: '/resume', description: 'reopen a past conversation'},
];

export function commandMatches(input: string) {
  if (!input.startsWith('/')) return [];
  return COMMANDS.filter((command) => command.value.startsWith(input));
}

export function completeCommand(input: string, index = 0): string {
  return commandMatches(input)[index]?.value ?? input;
}

export function CommandInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const matches = commandMatches(value);
  const [selected, setSelected] = useState(0);
  const active = matches.length ? selected % matches.length : 0;

  useEffect(() => {
    setSelected(0);
  }, [value]);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setSelected((current) => (current - 1 + matches.length) % matches.length);
      } else if (key.downArrow) {
        setSelected((current) => (current + 1) % matches.length);
      }
    },
    {isActive: matches.length > 0},
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.muted}>{' ❯ '}</Text>
        <Text color={theme.foreground}>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={(input) => onSubmit(completeCommand(input, active))}
          />
        </Text>
      </Box>
      {matches.map((command, index) => (
        <Text
          key={command.value}
          color={index === active ? theme.foreground : theme.muted}
        >
          {'   '}
          <Text
            bold
            color={index === active ? theme.foreground : theme.muted}
          >
            {command.value}
          </Text>
          {'  '}
          {command.description}
        </Text>
      ))}
    </Box>
  );
}
