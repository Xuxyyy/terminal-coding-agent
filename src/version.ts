import * as fs from 'node:fs';

type PackageManifest = {version?: unknown};

export function packageVersion(): string {
  const file = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PackageManifest;
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json has no valid version');
  }
  return manifest.version;
}
