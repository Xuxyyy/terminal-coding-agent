import {readFileSync} from 'node:fs';

export function sourceVersion(): {commit: string | null; digest: string | null; dirty: boolean | null} {
  try {
    return JSON.parse(readFileSync(new URL('../source-version.json', import.meta.url), 'utf8'));
  } catch {
    return {commit: null, digest: null, dirty: null};
  }
}
