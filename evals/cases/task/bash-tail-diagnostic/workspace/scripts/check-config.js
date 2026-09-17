import {settings} from '../config/settings.js';

if (settings.retries !== 3) {
  const noise = Array.from(
    {length: 420},
    (_, index) => `trace ${String(index + 1).padStart(4, '0')}: ${'.'.repeat(88)}`,
  ).join('\n');
  process.stdout.write(`${noise}\n`);
  process.stderr.write(
    `CONFIG_ERROR: expected retries to be 3 in config/settings.js, received ${settings.retries}\n`,
  );
  process.exitCode = 1;
} else {
  console.log('configuration valid');
}
