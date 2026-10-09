export async function globWorker(): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const {target, pattern, program, exclusions} = JSON.parse(input) as {target: string; pattern: string; program: string; exclusions: string[]};
    const excluded = exclusions.map((pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
    let stat: import('node:fs').Stats;
    try { stat = fs.statSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`path not found: ${target}`);
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${target}`);
    const realTarget = fs.realpathSync(target);
    if (realTarget.split(path.sep).some((part) => excluded.some((rule) => rule.test(part)))) {
      throw new Error('search directory is excluded from file discovery');
    }
    const result = spawnSync(program, [
      '--no-config', '--files', '--null', '--hidden', '--no-ignore', '--glob', pattern,
      ...exclusions.flatMap((name) => ['--glob', `!${name}`]), '--', '.',
    ], {cwd: realTarget, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
    if (result.error) throw result.error;
    const files: Array<{name: string; modified: number}> = [];
    let skipped = false;
    if (result.status !== 0 && result.status !== 1) {
      if (!/Permission denied|Operation not permitted/.test(result.stderr)) {
        throw new Error(`glob search failed: ${result.stderr.trim() || `ripgrep exited ${result.status}`}`);
      }
      skipped = true;
    }
    for (const name of result.stdout.split('\0').filter(Boolean)) {
      const targetFile = path.resolve(realTarget, name);
      try {
        const info = fs.lstatSync(targetFile);
        if (info.isFile()) files.push({name: targetFile, modified: info.mtimeMs});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped = true;
      }
    }
    files.sort((a, b) => b.modified - a.modified || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    console.log(JSON.stringify({files, skipped}));
  } catch (error) {
    console.log(JSON.stringify({error: (error as Error).message}));
  }
}
