import * as fs from 'node:fs';
import * as path from 'node:path';
import {expandUser, insideRoot, realPath} from './protected.js';
import {supportedParts} from './stages.js';
import {emptyEffects, type CommandEffects, type WriteTarget} from './effects.js';

type Value = 'text' | 'read' | 'directory';
type Options = {flags: string; long: string; values?: Record<string, Value>; optional?: string};
type Arguments = {
  known: boolean;
  operands: string[];
  reads: string[];
  flags: string[];
  directory?: string;
};

const DESTINATION_OPTIONS: Record<string, Value> = {'-t': 'directory', '--target-directory': 'directory'};
const WRITE_OPTIONS: Record<string, Options> = {
  cp: {
    flags: 'afinprRvHLPT',
    long: 'archive force interactive no-clobber preserve recursive verbose dereference ' +
      'no-dereference no-target-directory',
    values: DESTINATION_OPTIONS,
    optional: 'preserve',
  },
  mv: {
    flags: 'finvT',
    long: 'force interactive no-clobber verbose no-target-directory',
    values: DESTINATION_OPTIONS,
  },
  ln: {
    flags: 'sfhinvLPT',
    long: 'symbolic force interactive no-dereference verbose logical physical no-target-directory',
    values: DESTINATION_OPTIONS,
  },
  mkdir: {
    flags: 'pv', long: 'parents verbose', values: {'-m': 'text', '--mode': 'text'},
  },
  touch: {
    flags: 'acmhf', long: 'no-create no-dereference',
    values: {'-r': 'read', '--reference': 'read', '-d': 'text', '--date': 'text', '-t': 'text', '--time': 'text'},
  },
  tee: {flags: 'aip', long: 'append ignore-interrupts', optional: 'output-error'},
  rm: {
    flags: 'fiIrRdvP', long: 'force recursive dir verbose one-file-system preserve-root',
    optional: 'interactive preserve-root',
  },
  rmdir: {flags: 'pv', long: 'parents verbose ignore-fail-on-non-empty'},
};

function parseArguments(parts: string[], spec: Options): Arguments {
  const result: Arguments = {known: true, operands: [], reads: [], flags: []};
  const long = new Set(spec.long.split(' ').map((option) => `--${option}`));
  const optional = new Set((spec.optional ?? '').split(' ').map((option) => `--${option}`));
  let ended = false;
  function value(kind: Value, argument: string | undefined): void {
    if (argument === undefined || argument === '') { result.known = false; return; }
    if (kind === 'read') result.reads.push(argument);
    if (kind === 'directory') {
      if (result.directory !== undefined) result.known = false;
      result.directory = argument;
    }
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!ended && part === '--') { ended = true; continue; }
    if (ended || part === '-' || !part.startsWith('-')) { result.operands.push(part); continue; }
    if (part.startsWith('--')) {
      const equal = part.indexOf('=');
      const option = equal < 0 ? part : part.slice(0, equal);
      const kind = spec.values?.[option];
      if (kind) value(kind, equal < 0 ? parts[++index] : part.slice(equal + 1));
      else if (optional.has(option) || (equal < 0 && long.has(option))) result.flags.push(option);
      else result.known = false;
      continue;
    }
    for (let letter = 1; letter < part.length; letter += 1) {
      const option = `-${part[letter]}`;
      const kind = spec.values?.[option];
      if (kind) { value(kind, part.slice(letter + 1) || parts[++index]); break; }
      if (spec.flags.includes(part[letter])) result.flags.push(option);
      else result.known = false;
    }
  }
  return result;
}

function absolute(target: string, cwd: string): string {
  return path.resolve(cwd, expandUser(target));
}

function relativeLink(target: string, directory: string): string {
  return path.isAbsolute(target) ? target : `${directory}${path.sep}${target}`;
}

function uncertainPath(target: string): boolean {
  return target === '' || /[*?{}\[\]]/.test(target) || (target.startsWith('~') && target !== '~' && !target.startsWith('~/'));
}

function inspectPath(target: string, reading: boolean, result: CommandEffects, cwd: string, effect: WriteTarget = {path: target}): fs.Stats | null {
  if (reading) result.reads.push(target);
  else result.writes.push(effect);
  result.dependencies.push(absolute(target, cwd));
  if (!reading) result.changes.push(absolute(target, cwd));
  if (uncertainPath(target)) result.known = false;
  let candidate = absolute(target, cwd);
  const links = new Set<string>();
  for (;;) {
    const segments = candidate.split(path.sep).filter(Boolean);
    let prefix = path.parse(candidate).root;
    let restarted = false;
    for (let index = 0; index < segments.length; index += 1) {
      prefix = path.join(prefix, segments[index]);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(prefix); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.known = false;
        return null;
      }
      if (stat.isSymbolicLink()) {
        if (links.has(prefix)) { result.known = false; return null; }
        links.add(prefix);
        try {
          const referent = relativeLink(fs.readlinkSync(prefix), path.dirname(prefix));
          const suffix = segments.slice(index + 1).join(path.sep);
          candidate = suffix ? `${referent}${path.sep}${suffix}` : referent;
        }
        catch { result.known = false; return null; }
        if (reading) result.reads.push(candidate);
        else result.writes.push({...effect, path: candidate});
        result.dependencies.push(candidate);
        if (!reading) result.changes.push(candidate);
        candidate = path.resolve(candidate);
        restarted = true;
        break;
      }
      if (index === segments.length - 1) {
        if (!stat.isFile() && !stat.isDirectory()) result.known = false;
        return stat;
      }
    }
    if (!restarted) return fs.lstatSync(path.parse(candidate).root);
  }
}

export function inspectTargets(reads: string[], writes: WriteTarget[], cwd: string): CommandEffects {
  const result: CommandEffects = emptyEffects();
  for (const target of reads) inspectPath(target, true, result, cwd);
  for (const target of writes) inspectPath(target.path, false, result, cwd, target);
  return result;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function copyTree(source: string, destination: string, result: CommandEffects, root: string, cwd: string, follow: 'all' | 'arguments' | 'none', moving = false, ancestors = new Set<string>(), top = true): void {
  const sourcePath = absolute(source, cwd);
  const destinationPath = absolute(destination, cwd);
  const sourceStat = inspectPath(source, !moving, result, cwd);
  inspectPath(destination, false, result, cwd);
  if (!insideRoot(sourcePath, root) || !insideRoot(destinationPath, root)) return;
  if (!sourceStat) { result.known = false; return; }
  let link = false;
  try { link = fs.lstatSync(sourcePath).isSymbolicLink(); }
  catch { result.known = false; return; }
  if (link && (moving || follow === 'none' || (follow === 'arguments' && !top))) {
    try {
      inspectPath(relativeLink(fs.readlinkSync(sourcePath), path.dirname(destinationPath)), false, result, cwd);
    } catch { result.known = false; }
    return;
  }
  if (!sourceStat.isDirectory()) return;
  const physical = realPath(sourcePath);
  if (top || link) result.trees.push(sourcePath, physical);
  if (ancestors.has(physical) || overlaps(physical, realPath(destinationPath))) { result.known = false; return; }
  const nextAncestors = new Set([...ancestors, physical]);
  let children: string[];
  try { children = fs.readdirSync(sourcePath).sort(); }
  catch { result.known = false; return; }
  for (const child of children) {
    copyTree(path.join(sourcePath, child), path.join(destinationPath, child), result, root, cwd, follow, moving, nextAncestors, false);
  }
}

export function recoverableStage(text: string, root: string, cwd: string): CommandEffects | null {
  const parts = supportedParts(text);
  if (!parts?.length) return null;
  const [command, ...args] = parts;
  const spec = WRITE_OPTIONS[command];
  if (!spec) return null;
  const parsed = parseArguments(args, spec);
  const result: CommandEffects = emptyEffects(parsed.known);
  const has = (...flags: string[]): boolean => parsed.flags.some((flag) => flags.includes(flag));
  for (const read of parsed.reads) inspectPath(read, true, result, cwd);
  if (['cp', 'mv', 'ln'].includes(command)) {
    const sources = [...parsed.operands];
    const destination = parsed.directory ?? (sources.length > 1 ? sources.pop() : command === 'ln' ? '.' : undefined);
    const noDirectory = has('-T', '--no-target-directory');
    if (destination === undefined || !sources.length || (noDirectory && (parsed.directory !== undefined || sources.length !== 1))) {
      result.known = false;
      return result;
    }
    const destinationStat = inspectPath(destination, false, result, cwd);
    let linkDirectory = Boolean(destinationStat?.isDirectory());
    if (command === 'ln' && has('-h', '-n', '--no-dereference')) {
      try { if (fs.lstatSync(absolute(destination, cwd)).isSymbolicLink()) linkDirectory = false; }
      catch {}
    }
    const directory = parsed.directory !== undefined || (!noDirectory && linkDirectory);
    if (sources.length > 1 && !directory) result.known = false;
    const recursive = command === 'cp' && has('-R', '-r', '-a', '--recursive', '--archive');
    let follow: 'all' | 'arguments' | 'none' = recursive ? 'none' : 'all';
    for (const flag of parsed.flags) {
      if (flag === '-r' && process.platform === 'darwin') follow = 'all';
      if (flag === '-L' || flag === '--dereference') follow = 'all';
      if (flag === '-H') follow = 'arguments';
      if (flag === '-P' || flag === '--no-dereference' || flag === '-a' || flag === '--archive') follow = 'none';
    }
    const initialChanges = result.changes.length;
    for (const source of sources) {
      const priorTargets = result.changes.slice(initialChanges);
      const initialDependencies = result.dependencies.length;
      const sourcePath = absolute(source, cwd);
      const contents = recursive && (/\/\.\/*$/.test(source) || (process.platform === 'darwin' && source.endsWith('/')));
      const target = directory && !contents ? path.join(absolute(destination, cwd), path.basename(sourcePath)) : destination;
      const symbolic = command === 'ln' && has('-s', '--symbolic');
      const sourceStat = symbolic ? null : inspectPath(source, command === 'cp', result, cwd, {path: source, destructive: command === 'mv'});
      let sourceLink = false;
      if (!symbolic && sourceStat) {
        try { sourceLink = fs.lstatSync(sourcePath).isSymbolicLink(); }
        catch { result.known = false; }
      }
      inspectPath(target, false, result, cwd);
      if (command === 'ln') {
        if (symbolic) {
          inspectPath(relativeLink(expandUser(source), path.dirname(absolute(target, cwd))), false, result, cwd);
        } else if (sourceLink && (has('-P', '--physical') || (process.platform !== 'darwin' && !has('-L', '--logical')))) {
          copyTree(source, target, result, root, cwd, 'none', true);
        } else if (sourceStat?.isDirectory()) result.known = false;
      } else if (recursive || (command === 'mv' && (sourceStat?.isDirectory() || sourceLink)) ||
        (command === 'cp' && process.platform !== 'darwin' && follow === 'none' && sourceLink)) {
        copyTree(source, target, result, root, cwd, follow, command === 'mv');
      } else if (sourceStat?.isDirectory()) result.known = false;
      if (affectedPaths(result.dependencies.slice(initialDependencies), priorTargets)) result.known = false;
    }
    if (command === 'cp' && affectedPaths(result.trees, result.changes)) result.known = false;
  } else {
    if (!parsed.operands.length && command !== 'tee') result.known = false;
    for (const target of parsed.operands) {
      const destroys = command === 'rm' || command === 'rmdir';
      inspectPath(target, false, result, cwd, {path: target, destructive: destroys, destroys});
      if (command === 'rmdir' && has('-p', '--parents')) {
        let parent = path.dirname(target);
        while (parent !== '.' && parent !== path.dirname(parent)) {
          inspectPath(parent, false, result, cwd, {path: parent, destructive: true, destroys: true});
          parent = path.dirname(parent);
        }
        if (path.isAbsolute(target) || target.startsWith('./')) {
          inspectPath(parent, false, result, cwd, {path: parent, destructive: true, destroys: true});
        }
      }
    }
  }
  return result;
}

export function affectedPaths(dependencies: string[], changes: string[]): boolean {
  if (!dependencies.length || !changes.length) return false;
  function roots(paths: string[]): string[] {
    const result = new Set<string>();
    for (const target of [...new Set(paths.map((value) => path.resolve(value)))].sort((a, b) => a.length - b.length)) {
      let ancestor = target;
      while (!result.has(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
      if (!result.has(ancestor)) result.add(target);
    }
    return [...result];
  }
  const changedRoots = roots(changes);
  return roots(dependencies).some((dependency) => changedRoots.some((change) => overlaps(change, dependency) || overlaps(dependency, change)));
}
