import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';

function files(root) {
  return readdirSync(root, {withFileTypes: true}).flatMap((entry) => entry.isDirectory() ? files(`${root}/${entry.name}`) : entry.isFile() ? [`${root}/${entry.name}`] : []);
}
const hash = createHash('sha256');
for (const file of [...files('src'), 'package.json', 'package-lock.json', 'tsconfig.json'].sort()) {
  hash.update(file).update('\0').update(readFileSync(file)).update('\0');
}
let commit = null;
let dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim());
} catch {}
writeFileSync('dist/source-version.json', JSON.stringify({commit, dirty, digest: hash.digest('hex')}) + '\n');
