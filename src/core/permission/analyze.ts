import * as path from 'node:path';
import type {CommandEffects, WriteTarget} from './effects.js';
import {observeStage} from './observe.js';
import {affectedPaths, inspectTargets, recoverableStage} from './recoverable.js';
import {expandUser, realPath} from './protected.js';
import {basename, commandParts, parseRedirects, supportedParts} from './stages.js';

export type StageAnalysis = CommandEffects & {
  parts: string[];
  substitution: boolean;
  selfAffected: boolean;
  changesDirectory: boolean;
  directory?: string;
  projectRunner: string | null;
  runnerSyntaxKnown: boolean;
};

const PROJECT_RUNNERS: Record<string, readonly string[]> = {
  npm: ['test', 'run'],
  pnpm: ['test', 'run'],
  yarn: ['test', 'run'],
};

const SUBSTITUTION_PATTERN = /[`$()]/;

function findWrites(parts: string[]): WriteTarget[] {
  if (parts[0] !== 'find') return [];
  const roots: string[] = [];
  const writes: WriteTarget[] = [];
  for (const part of parts.slice(1)) {
    if (['-H', '-L', '-P'].includes(part) && !roots.length) continue;
    if (part.startsWith('-') || part === '!') break;
    roots.push(part);
  }
  const valued = new Set(('name iname path ipath wholename iwholename regex iregex type xtype ' +
    'maxdepth mindepth mtime mmin atime amin ctime cmin size perm user group uid gid links ' +
    'inum regextype printf newermt newer anewer cnewer samefile').split(' ').map((name) => `-${name}`));
  for (let index = 1; index < parts.length; index += 1) {
    const option = parts[index];
    if (valued.has(option)) { index += 1; continue; }
    if (['-fprint', '-fls', '-fprintf'].includes(option)) {
      const target = parts[++index];
      if (target !== undefined) writes.push({path: target});
      if (option === '-fprintf') index += 1;
    }
    if (['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(option)) {
      writes.push(...(roots.length ? roots : ['.']).map((target) => ({path: target, destroys: true})));
      if (option !== '-delete') break;
    }
  }
  return writes;
}

function isProjectRunner(stage: string, parts: string[]): boolean {
  if (SUBSTITUTION_PATTERN.test(stage)) return false;
  const subcommands = PROJECT_RUNNERS[parts[0]];
  return Boolean(subcommands && parts.length > 1 && subcommands.includes(parts[1]));
}

export function analyzeStage(stage: string, root: string, cwd: string): StageAnalysis | null {
  const normalized = commandParts(stage);
  if (normalized === null) return null;
  const redirects = parseRedirects(stage);
  const observation = observeStage(redirects.text);
  const directoryObservation = redirects.text === stage ? observation : observeStage(stage);
  const parts = observation?.lookup && observation.known ? observation.parts : normalized;
  const writer = recoverableStage(redirects.text, root, cwd);
  const baseParts = supportedParts(redirects.text) ?? [];
  const deletions = findWrites(commandParts(redirects.text) ?? []);
  const runner = isProjectRunner(redirects.text, baseParts);
  const externalWrites = [...redirects.writes, ...(observation?.writes ?? []), ...deletions];
  const observedReads = [...redirects.reads, ...(observation?.reads ?? [])];
  const inspected = externalWrites.length || redirects.reads.length
    ? inspectTargets(observedReads, externalWrites, cwd) : null;
  const reads = [...(inspected?.reads ?? observedReads), ...(writer?.reads ?? [])];
  const writes = [...(inspected?.writes ?? externalWrites), ...(writer?.writes ?? [])];
  const dependencies = [...(writer?.dependencies ?? []), ...(inspected?.dependencies ?? []),
    ...reads.map((target) => path.resolve(cwd, expandUser(target)))];
  const changes = [...(writer?.changes ?? []), ...(inspected?.changes ?? [])];
  if (runner) { dependencies.push(realPath(root)); changes.push(realPath(root)); }
  const knownDeletion = deletions.length > 0 && observeStage(redirects.text.replace(/(?:^|\s)-delete(?=\s|$)/g, ' '))?.known;
  const syntaxKnown = redirects.known && (inspected?.known ?? true);
  return {
    parts,
    reads,
    writes,
    dependencies,
    changes,
    trees: [...(writer?.trees ?? []), ...(inspected?.trees ?? [])],
    known: Boolean(syntaxKnown && (writer?.known ?? (observation?.known || knownDeletion))),
    substitution: SUBSTITUTION_PATTERN.test(stage),
    selfAffected: affectedPaths(writer?.trees ?? [], inspected?.changes ?? []),
    changesDirectory: directoryObservation?.directory !== undefined || basename(normalized[0] ?? '') === 'cd',
    directory: directoryObservation?.directory,
    projectRunner: runner ? `${baseParts[0]} ${baseParts[1]}` : null,
    runnerSyntaxKnown: Boolean(runner && syntaxKnown && (writer?.known ?? true)),
  };
}
