import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ACC_HOME =
  process.env.ACC_HOME || path.join(os.homedir(), '.acc');
export const COMMAND_HISTORY_PATH = path.join(ACC_HOME, 'prompt-history');

export function parseCommandHistory(content: string): string[] {
  const entries: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (!lines.length) return;
    entries.push(lines.join('\n'));
    lines = [];
  };
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('+')) {
      lines.push(line.slice(1));
    } else {
      flush();
    }
  }
  flush();
  return entries.filter(Boolean);
}

export function loadCommandHistory(
  historyPath = COMMAND_HISTORY_PATH,
): string[] {
  try {
    return parseCommandHistory(fs.readFileSync(historyPath, 'utf8'));
  } catch {
    return [];
  }
}

export function appendCommandHistory(
  command: string,
  historyPath = COMMAND_HISTORY_PATH,
): void {
  const lines = command.split('\n').map((line) => `+${line}\n`).join('');
  try {
    fs.mkdirSync(path.dirname(historyPath), {recursive: true});
    fs.appendFileSync(historyPath, `\n# ${new Date().toISOString()}\n${lines}`);
  } catch {
    return;
  }
}
