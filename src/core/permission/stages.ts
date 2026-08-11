export type Stage = {text: string; separator: string};

const STAGE_SEPARATORS = ['&&', '||', '|&', ';', '|', '&', '\r\n', '\n', '\r'];
const HEREDOC_PATTERN = /<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][\w.-]*))/y;
const DISCARDED_REDIRECT_PATTERN =
  /\s*(?:\d*>&\d+|\d*>>?\s*\/dev\/(?:null|stdout|stderr)\b|<\s*\/dev\/null\b)/g;
const ASSIGNMENT_PATTERN = /^[A-Za-z_]\w*=/;
const DURATION_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/;

const COMMAND_WRAPPERS: Record<string, readonly string[]> = {
  builtin: [],
  command: [],
  env: ['-u', '--unset'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  noglob: [],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  time: ['-f', '--format', '-o', '--output'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: [],
};

export function basename(value: string): string {
  const parts = value.split('/').filter((part) => part !== '');
  return parts.length ? parts[parts.length - 1] : value;
}

export function discardNoiseRedirects(stage: string): string {
  return stage.replace(DISCARDED_REDIRECT_PATTERN, '');
}

function separatorAt(command: string, index: number): string | null {
  const character = command[index];
  const previous = command[index - 1];
  if ((character === '&' || character === '|') && index > 0 && (previous === '<' || previous === '>')) {
    return null;
  }
  if (command.startsWith('&>', index)) return null;
  return STAGE_SEPARATORS.find((separator) => command.startsWith(separator, index)) ?? null;
}

function heredocEnd(command: string, match: RegExpExecArray, from: number): number {
  const delimiter = match[2] ?? match[3] ?? match[4] ?? '';
  const indented = match[1] === '-';
  let position = command.indexOf('\n', from + match[0].length);
  if (position === -1) return command.length;
  position += 1;
  while (position <= command.length) {
    const lineEnd = command.indexOf('\n', position);
    const end = lineEnd === -1 ? command.length : lineEnd;
    const line = command.slice(position, end).replace(/\r+$/, '');
    if ((indented ? line.replace(/^\t+/, '') : line) === delimiter) return end;
    if (lineEnd === -1) return command.length;
    position = lineEnd + 1;
  }
  return command.length;
}

export function splitStages(command: string): Stage[] | null {
  const stages: Stage[] = [];
  let buffer = '';
  let quote = '';
  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (quote) {
      buffer += character;
      if (character === '\\' && quote === '"' && index + 1 < command.length) {
        buffer += command[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) quote = '';
      index += 1;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      buffer += character + command[index + 1];
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      buffer += character;
      index += 1;
      continue;
    }
    HEREDOC_PATTERN.lastIndex = index;
    const heredoc = HEREDOC_PATTERN.exec(command);
    if (heredoc) {
      const end = heredocEnd(command, heredoc, index);
      buffer += command.slice(index, end);
      index = end;
      continue;
    }
    const separator = separatorAt(command, index);
    if (separator !== null) {
      stages.push({text: buffer, separator});
      buffer = '';
      index += separator.length;
      continue;
    }
    buffer += character;
    index += 1;
  }
  if (quote) return null;
  stages.push({text: buffer, separator: ''});
  return stages;
}

export function tokenize(text: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let started = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      index += 1;
      continue;
    }
    if (character === '\\') {
      if (index + 1 >= text.length) return null;
      current += text[index + 1];
      started = true;
      index += 2;
      continue;
    }
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return null;
      current += text.slice(index + 1, end);
      started = true;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      let closed = false;
      while (index < text.length) {
        const inner = text[index];
        if (inner === '\\') {
          const next = text[index + 1];
          if (next === undefined) return null;
          current += next === '"' || next === '\\' ? next : inner + next;
          index += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        current += inner;
        index += 1;
      }
      if (!closed) return null;
      started = true;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) parts.push(current);
  return parts;
}

function wrappedCommand(parts: string[], wrapper: string, valued: readonly string[]): number {
  let index = 1;
  if (wrapper === 'xargs' && index < parts.length && parts[index].startsWith('-')) {
    return 0;
  }
  while (index < parts.length && parts[index].startsWith('-')) {
    if (valued.includes(parts[index])) index += 1;
    index += 1;
  }
  if (wrapper === 'timeout' && index < parts.length && DURATION_PATTERN.test(parts[index])) {
    index += 1;
  }
  return index < parts.length ? index : 0;
}

export function stripWrappers(parts: string[]): string[] {
  let current = parts;
  while (current.length) {
    let assignments = 0;
    while (assignments < current.length && ASSIGNMENT_PATTERN.test(current[assignments])) {
      assignments += 1;
    }
    if (assignments) {
      if (assignments === current.length) return current;
      current = current.slice(assignments);
      continue;
    }
    const wrapper = basename(current[0]);
    const valued = COMMAND_WRAPPERS[wrapper];
    if (!valued) return current;
    const start = wrappedCommand(current, wrapper, valued);
    if (start === 0) return current;
    current = current.slice(start);
  }
  return current;
}

export function commandParts(stage: string): string[] | null {
  const parts = tokenize(discardNoiseRedirects(stage));
  return parts === null ? null : stripWrappers(parts);
}
