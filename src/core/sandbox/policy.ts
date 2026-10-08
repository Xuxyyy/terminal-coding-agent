import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {z} from 'zod';
import {expandUser, insideRoot, realPath} from '../permission/protected.js';

export const accessSchema = z.object({
  read_paths: z.array(z.string().min(1)).max(16).optional()
    .describe('Extra read paths; user approval required for this call.'),
  write_paths: z.array(z.string().min(1)).max(16).optional()
    .describe('Extra read/write paths; user approval required for this call.'),
  network: z.boolean().optional()
    .describe('Request network access for this call and its children; requires user approval.'),
}).strict();

export type SandboxAccess = {read_paths?: string[]; write_paths?: string[]; network?: boolean};
export type SandboxPolicy = {
  root: string;
  temporary: string;
  reads: string[];
  writes: string[];
  blocked: string[];
  protectedWrites: string[];
  network: boolean;
};

const PRIVATE_DIRECTORIES = new Set(['.acc', '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.claude', '.codex', '.kube']);
const PRIVATE_FILES = new Set(['.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519', 'credentials.json']);
const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
export const PRIVATE_PATTERN = '/(\\.acc|\\.ssh|\\.aws|\\.azure|\\.gnupg|\\.docker|\\.claude|\\.codex|\\.kube)(/|$)|/(\\.npmrc|\\.netrc|\\.git-credentials|id_rsa|id_ed25519|credentials\\.json)(/|$)|/\\.config/(gcloud|gh)(/|$)|/[^/]+\\.(pem|key|p12|pfx)$';
export const ENV_PATTERN = '/\\.env($|[./])';
const PROTECTED_FILES = new Set(['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.envrc', '.yarnrc', '.pre-commit-config.yaml', '.mcp.json']);
const PROTECTED_DIRECTORIES = new Set(['.vscode', '.idea', '.husky', '.devcontainer']);
const PUBLIC_CERTIFICATES = ['/etc/ssl/certs', '/etc/pki/tls/certs', '/private/etc/ssl/cert.pem'];

export function publicCertificate(target: string): boolean {
  return PUBLIC_CERTIFICATES.some((root) => target === root || target.startsWith(`${root}/`));
}

export function privateName(name: string): boolean {
  name = name.toLowerCase();
  return PRIVATE_DIRECTORIES.has(name) || PRIVATE_FILES.has(name) ||
    (name.startsWith('.env') && (name === '.env' || name.startsWith('.env.')) && !ENV_EXAMPLES.has(name)) ||
    /\.(pem|key|p12|pfx)$/.test(name);
}

export function absoluteTarget(root: string, target: string): string {
  if (target.includes('\0')) throw new Error('sandbox paths cannot contain NUL');
  return realPath(path.resolve(root, expandUser(target)));
}

export function credentialPath(target: string): boolean {
  if (publicCertificate(target)) return false;
  const parts = path.resolve(target).split(path.sep);
  return parts.some(privateName) || /\/\.config\/(gcloud|gh)(\/|$)/i.test(target);
}

export function normalizeAccess(root: string, access: SandboxAccess = {}): SandboxAccess {
  const paths = (items: string[] = []) => [...new Set(items.map((item) => {
    const target = absoluteTarget(root, item);
    if (target === path.parse(target).root || target === realPath(os.homedir())) {
      throw new Error('sandbox access must name a specific file or directory, not the filesystem root or home directory');
    }
    if (credentialPath(path.resolve(root, expandUser(item))) || credentialPath(target)) {
      throw new Error('sandbox blocks credential storage; an access grant cannot expose it');
    }
    return target;
  }))];
  return {read_paths: paths(access.read_paths), write_paths: paths(access.write_paths), network: access.network === true};
}

export function hasAccess(access: SandboxAccess): boolean {
  return Boolean(access.network || access.read_paths?.length || access.write_paths?.length);
}

export function accessReason(access: SandboxAccess): string {
  const parts = [
    ...(access.read_paths ?? []).map((target) => `read ${JSON.stringify(target)}`),
    ...(access.write_paths ?? []).map((target) => `read and write ${JSON.stringify(target)}`),
    ...(access.network ? ['use the network (readable project data can be sent outward)'] : []),
  ];
  return `Extra sandbox access for this command and its children only: ${parts.join('; ')}. Credential protection remains active.`;
}

export function cleanEnvironment(temporary: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_CONFIG_HOME: path.join(temporary, 'config'),
    npm_config_cache: path.join(temporary, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'NO_COLOR', 'FORCE_COLOR']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}

export function executable(name: string, envPath = process.env.PATH ?? ''): string | null {
  for (const directory of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const target = path.join(directory, name);
    try {
      fs.accessSync(target, fs.constants.X_OK);
      if (fs.statSync(target).isFile()) return fs.realpathSync(target);
    } catch {}
  }
  return null;
}

export function runtimeRoots(): string[] {
  const roots = ['/bin', '/sbin', '/usr', '/opt/homebrew', '/System/Library', '/Library/Developer', '/Library/Apple', '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc/localtime', '/private/etc/ssl/openssl.cnf', '/private/etc/ssl/cert.pem'];
  roots.push(path.dirname(fs.realpathSync(process.execPath)));
  const nodeDirectory = path.dirname(fs.realpathSync(process.execPath));
  if (path.basename(nodeDirectory) === 'bin') roots.push(path.dirname(nodeDirectory));
  const rg = executable('rg');
  if (rg) roots.push(path.dirname(rg));
  return [...new Set(roots.filter((target) => fs.existsSync(target)).map(realPath))];
}

function protectedWrite(target: string): boolean {
  const parts = target.split(path.sep);
  return parts.some((part) => PROTECTED_DIRECTORIES.has(part)) ||
    PROTECTED_FILES.has(path.basename(target)) || /\/\.git\/(config|hooks)(\/|$)/.test(target);
}

function scan(root: string, blocked: Set<string>, protectedWrites: Set<string>, files: Map<string, string[]>): void {
  const visit = (target: string): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isSymbolicLink() && publicCertificate(realPath(target))) return;
    if (stat.isSocket()) { blocked.add(target); return; }
    if (credentialPath(target)) {
      blocked.add(target);
      if (stat.isSymbolicLink()) blocked.add(realPath(target));
      if (stat.isFile()) {
        const key = `${stat.dev}:${stat.ino}`;
        for (const alias of files.get(key) ?? []) blocked.add(alias);
        files.set(key, [...(files.get(key) ?? []), target]);
      }
      return;
    }
    if (protectedWrite(target)) protectedWrites.add(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const key = `${stat.dev}:${stat.ino}`;
      const aliases = files.get(key) ?? [];
      if (aliases.some((alias) => blocked.has(alias))) blocked.add(target);
      files.set(key, [...aliases, target]);
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try { entries = fs.readdirSync(target); } catch { return; }
      for (const entry of entries) visit(path.join(target, entry));
    }
  };
  visit(root);
}

export function makePolicy(root: string, temporary: string, access: SandboxAccess = {}): SandboxPolicy {
  const base = realPath(root);
  if (credentialPath(base) || base === path.parse(base).root || base === realPath(os.homedir())) {
    throw new Error('sandbox requires a project directory outside credential storage; do not use your home or filesystem root');
  }
  const granted = normalizeAccess(base, access);
  const blocked = new Set<string>();
  const protectedWrites = new Set<string>();
  const files = new Map<string, string[]>();
  for (const credential of [path.join(base, '.env'), path.join(os.homedir(), '.acc', '.env')]) {
    blocked.add(credential);
    blocked.add(realPath(credential));
    try {
      const stat = fs.statSync(credential);
      files.set(`${stat.dev}:${stat.ino}`, [credential]);
    } catch {}
  }
  const extraReads = granted.read_paths ?? [];
  const extraWrites = granted.write_paths ?? [];
  const runtimes = runtimeRoots();
  const scanned = [base, ...extraReads, ...extraWrites];
  const roots = scanned.filter((target, index) => !scanned.some((other, otherIndex) => otherIndex !== index && other !== target && insideRoot(target, other)));
  for (const target of new Set(roots)) scan(target, blocked, protectedWrites, files);
  for (const aliases of files.values()) {
    if (aliases.some((alias) => blocked.has(alias))) for (const alias of aliases) blocked.add(alias);
  }
  const protections = [...protectedWrites].filter((target) => !extraWrites.some((grant) => insideRoot(target, grant)));
  return {
    root: base,
    temporary: realPath(temporary),
    reads: [...new Set([base, realPath(temporary), ...runtimes, ...extraReads, ...extraWrites])],
    writes: [...new Set([base, realPath(temporary), ...extraWrites])],
    blocked: [...blocked],
    protectedWrites: protections,
    network: granted.network === true,
  };
}
