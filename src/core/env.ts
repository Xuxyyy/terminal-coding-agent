import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function envFiles(): string[] {
  return [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.acc', '.env'),
  ];
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7) : line;
    const separator = withoutExport.indexOf('=');
    if (separator < 1) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

let loaded = false;

export function loadEnvFiles(files: string[] = envFiles()): void {
  if (loaded) return;
  loaded = true;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
