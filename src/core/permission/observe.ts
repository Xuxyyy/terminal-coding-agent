import {emptyEffects, type CommandEffects} from './effects.js';
import {maskQuotedRedirects, tokenize} from './stages.js';

const NOISE_REDIRECTS = /\s*(?:\d*>&\d+(?=\s|$)|\d*>>?\s*\/dev\/(?:null|stdout|stderr)(?=\s|$)|<\s*\/dev\/null(?=\s|$))/g;

// Keep saved-rule normalization unchanged; classification requires an exact noise target.
export function observationText(stage: string, preservePositions = false): string {
  return stage.replace(NOISE_REDIRECTS, (match) => preservePositions ? ' '.repeat(match.length) : '');
}

type Value = 'text' | 'pattern' | 'pattern-file' | 'read' | 'read-list' | 'indirect' | 'write';
type Options = {
  flags?: string;
  long?: string;
  values?: Record<string, Value>;
  optional?: string;
  numeric?: boolean;
  stopAtOperand?: boolean;
};
type Arguments = {
  operands: string[];
  reads: string[];
  writes: string[];
  pattern: boolean;
  known: boolean;
};
export type Observation = CommandEffects & {
  parts: string[];
  lookup?: boolean;
  directory?: string;
};

const VERSION_OPTIONS: Record<string, string[]> = {
  node: ['--version', '-v'], npm: ['--version', '-v'], pnpm: ['--version', '-v'],
  yarn: ['--version', '-v'], bun: ['--version', '-v'], deno: ['--version', '-V'],
  python: ['--version', '-V', '-VV'], python3: ['--version', '-V', '-VV'],
  bash: ['--version'], zsh: ['--version'], git: ['--version', '-v'],
  tsc: ['--version', '-v'], rustc: ['--version', '-V'], cargo: ['--version', '-V'],
};
const SEARCH_VALUES: Record<string, Value> = {
  '-e': 'pattern', '--regexp': 'pattern', '-f': 'pattern-file', '--file': 'pattern-file',
  '-m': 'text', '--max-count': 'text', '-A': 'text', '--after-context': 'text',
  '-B': 'text', '--before-context': 'text', '-C': 'text', '--context': 'text',
  '--include': 'text', '--exclude': 'text', '--exclude-dir': 'text',
  '--exclude-from': 'read', '--label': 'text', '--binary-files': 'text',
};
const READ_OPTIONS: Record<string, Options> = {
  cat: {
    flags: 'AbEnstTuv',
    long: 'show-all number number-nonblank show-ends squeeze-blank show-tabs show-nonprinting ' +
      'help version',
  },
  cd: {
    flags: 'LP',
  },
  diff: {
    flags: 'abBcdEipPqrsStyuw',
    long: 'brief report-identical-files recursive ignore-case ignore-all-space ' +
      'ignore-space-change ignore-blank-lines strip-trailing-cr help version',
    optional: 'unified context',
    values: {
      '-I': 'text',
      '--ignore-matching-lines': 'text',
      '-U': 'text',
      '-C': 'text',
      '-L': 'text',
      '--label': 'text',
      '-x': 'text',
      '--exclude': 'text',
      '-X': 'read',
      '--exclude-from': 'read',
      '--from-file': 'read',
      '--to-file': 'read',
    },
  },
  grep: {
    flags: 'EFGPivwxyonHhclLqsrRbzZaIU',
    long: 'extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case ' +
      'word-regexp line-regexp invert-match line-number with-filename no-filename ' +
      'only-matching quiet silent count files-with-matches files-without-match recursive ' +
      'dereference-recursive text binary byte-offset null null-data no-messages ' +
      'line-buffered help version',
    optional: 'color colour',
    values: {
      ...SEARCH_VALUES,
      '-d': 'text',
      '--directories': 'text',
      '-D': 'text',
      '--devices': 'text',
    },
  },
  rg: {
    flags: 'FivwxonHhclLqsUaINPS',
    long: 'files hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-global no-ignore-dot ' +
      'no-config ignore-case case-sensitive smart-case fixed-strings word-regexp line-regexp ' +
      'invert-match line-number no-line-number with-filename no-filename only-matching quiet ' +
      'count count-matches files-with-matches files-without-match follow text binary null ' +
      'null-data no-messages line-buffered multiline multiline-dotall pcre2 stats heading ' +
      'no-heading trim passthru help version',
    values: {
      ...SEARCH_VALUES,
      '-g': 'text',
      '--glob': 'text',
      '--iglob': 'text',
      '-t': 'text',
      '--type': 'text',
      '-T': 'text',
      '--type-not': 'text',
      '--type-add': 'text',
      '--type-clear': 'text',
      '--ignore-file': 'read',
      '--pre': 'indirect',
      '--color': 'text',
      '--colors': 'text',
      '--encoding': 'text',
      '--engine': 'text',
      '--max-depth': 'text',
      '--max-filesize': 'text',
      '--threads': 'text',
      '-j': 'text',
      '--sort': 'text',
      '--sortr': 'text',
      '-r': 'text',
      '--replace': 'text',
      '--path-separator': 'text',
      '--context-separator': 'text',
    },
  },
  head: {
    flags: 'qvz',
    long: 'quiet silent verbose zero-terminated help version',
    numeric: true,
    values: {
      '-n': 'text',
      '--lines': 'text',
      '-c': 'text',
      '--bytes': 'text',
    },
  },
  tail: {
    flags: 'fFqvz',
    long: 'quiet silent verbose zero-terminated retry help version',
    numeric: true,
    optional: 'follow',
    values: {
      '-n': 'text',
      '--lines': 'text',
      '-c': 'text',
      '--bytes': 'text',
      '--pid': 'text',
      '-s': 'text',
      '--sleep-interval': 'text',
      '--max-unchanged-stats': 'text',
    },
  },
  ls: {
    flags: 'ABCDFGHILOPRSTUWabcdefghiklmnopqrstuwx1',
    long: 'all almost-all directory human-readable inode numeric-uid-gid recursive reverse size ' +
      'width across classify dereference dereference-command-line full-time literal ' +
      'quote-name escape no-group group-directories-first help version',
    optional: 'color hyperlink',
    values: {
      '--ignore': 'text',
      '--hide': 'text',
      ...(process.platform === 'darwin' ? {'-D': 'text' as const} : {'-I': 'text' as const, '-w': 'text' as const, '-T': 'text' as const}),
      '--width': 'text',
      '--tabsize': 'text',
      '--block-size': 'text',
      '--format': 'text',
      '--indicator-style': 'text',
      '--quoting-style': 'text',
      '--sort': 'text',
      '--time': 'text',
      '--time-style': 'text',
    },
  },
  od: {
    flags: 'abcdfhilosvx',
    long: 'traditional help version',
    values: {
      '-A': 'text',
      '--address-radix': 'text',
      '-j': 'text',
      '--skip-bytes': 'text',
      '-N': 'text',
      '--read-bytes': 'text',
      '-t': 'text',
      '--format': 'text',
    },
    optional: 'width',
  },
  pwd: {
    flags: 'LP',
    long: 'logical physical help version',
  },
  sort: {
    flags: 'bdfghinRrMsuzmVc',
    long: 'ignore-leading-blanks dictionary-order ignore-case general-numeric-sort ' +
      'human-numeric-sort ignore-nonprinting month-sort numeric-sort random-sort reverse ' +
      'stable unique merge zero-terminated version-sort help version',
    optional: 'check',
    values: {
      '-k': 'text',
      '--key': 'text',
      '-t': 'text',
      '--field-separator': 'text',
      '-S': 'text',
      '--buffer-size': 'text',
      '--parallel': 'text',
      '--batch-size': 'text',
      '--random-source': 'read',
      '--files0-from': 'indirect',
      '-o': 'write',
      '--output': 'write',
      '-T': 'write',
      '--temporary-directory': 'write',
    },
  },
  wc: {
    flags: 'clLmw',
    long: 'bytes chars lines max-line-length words help version',
    values: {
      '--files0-from': 'indirect',
    },
  },
  file: {
    flags: 'bciIkLhnN0rs',
    long: 'brief checking-printout mime mime-type mime-encoding extension keep-going list ' +
      'dereference no-dereference no-buffer no-pad print0 raw special-files help version',
    values: {
      '-m': 'read-list',
      '-M': 'read-list',
      '--magic-file': 'read-list',
      '-f': 'indirect',
      '--files-from': 'indirect',
      '-e': 'text',
      '--exclude': 'text',
      '--exclude-quiet': 'text',
      '-F': 'text',
      '--separator': 'text',
      '-P': 'text',
      '--parameter': 'text',
    },
  },
  stat: process.platform === 'darwin'
    ? {flags: 'FLlnqrsx', values: {'-f': 'text', '-t': 'text'}}
    : {
    flags: 'fLt',
    long: 'file-system dereference terse help version',
    values: {
      '-c': 'text',
      '--format': 'text',
      '--printf': 'text',
    },
    optional: 'cached',
  },
  uname: {
    flags: 'asnrvmpio',
    long: 'all kernel-name nodename kernel-release kernel-version machine processor ' +
      'hardware-platform operating-system help version',
  },
};

function parseArguments(parts: string[], spec: Options): Arguments {
  const result: Arguments = {operands: [], reads: [], writes: [], pattern: false, known: true};
  const long = new Set((spec.long ?? '').split(' ').map((name) => `--${name}`));
  const optional = new Set((spec.optional ?? '').split(' ').map((name) => `--${name}`));
  let ended = false;
  function value(kind: Value, argument: string | undefined): void {
    if (argument === undefined) { result.known = false; return; }
    if (kind === 'pattern' || kind === 'pattern-file') result.pattern = true;
    if (kind === 'read' || kind === 'indirect' || kind === 'pattern-file') result.reads.push(argument);
    if (kind === 'read-list') result.reads.push(...argument.split(':'));
    if (kind === 'write') result.writes.push(argument);
    if (kind === 'indirect') result.known = false;
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!ended && part === '--') { ended = true; continue; }
    if (ended || part === '-' || !part.startsWith('-')) {
      result.operands.push(part);
      ended ||= spec.stopAtOperand ?? false;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(part)) continue;
    if (part.startsWith('--')) {
      const equal = part.indexOf('=');
      const option = equal < 0 ? part : part.slice(0, equal);
      const kind = spec.values?.[option];
      if (kind) value(kind, equal < 0 ? parts[++index] : part.slice(equal + 1));
      else if (!(optional.has(option) || (equal < 0 && long.has(option)))) result.known = false;
      continue;
    }
    for (let letter = 1; letter < part.length; letter += 1) {
      const option = `-${part[letter]}`;
      const kind = spec.values?.[option];
      if (kind) { value(kind, part.slice(letter + 1) || parts[++index]); break; }
      if (!spec.flags?.includes(part[letter])) result.known = false;
    }
  }
  return result;
}

const GIT_LIST_OPTIONS: Options = {
  numeric: true,
  long: 'oneline no-color no-patch',
  optional: 'color pretty decorate',
  values: {'-n': 'text', '--max-count': 'text', '--format': 'text', '--since': 'text',
    '--until': 'text', '--author': 'text', '--grep': 'text'},
};

function gitArguments(args: string[]): Arguments | null {
  const [subcommand, ...options] = args;
  if (['diff', 'log', 'ls-files', 'show', 'status'].includes(subcommand)) {
    return parseArguments(options, {
      flags: 'puwbz', numeric: true,
      long: 'no-ext-diff no-textconv oneline stat shortstat numstat name-only name-status check quiet exit-code cached staged patch no-patch short branch porcelain ignored untracked no-color' +
        (subcommand === 'log' ? ' graph no-decorate' : ''),
      optional: 'color pretty porcelain untracked-files' + (subcommand === 'log' ? ' decorate' : ''),
      values: {...GIT_LIST_OPTIONS.values, '--exclude-from': 'read'},
    });
  }
  if (subcommand === 'branch') {
    const parsed = parseArguments(options, {
      flags: 'arlv', long: 'all remotes list show-current verbose no-color', optional: 'color',
    });
    const end = options.indexOf('--');
    const flags = end < 0 ? options : options.slice(0, end);
    const listing = flags.some((option) => option === '--list' || /^-[arlv]*l[arlv]*$/.test(option));
    if (parsed.operands.length && !listing) parsed.known = false;
    return parsed;
  }
  if (subcommand === 'reflog') {
    if (options.length && options[0] !== 'show' && !options[0].startsWith('-')) return null;
    return parseArguments(options[0] === 'show' ? options.slice(1) : options, GIT_LIST_OPTIONS);
  }
  if (subcommand === 'stash' && options[0] === 'list') {
    return parseArguments(options.slice(1), GIT_LIST_OPTIONS);
  }
  if (subcommand === 'config') {
    const modern = options[0] === 'list';
    const flags = modern ? options.slice(1) : options;
    const parsed = parseArguments(flags, {
      flags: 'lz', long: 'list null show-origin show-scope local',
    });
    const listing = modern || flags.some((option) => option === '--list' || /^-[lz]*l[lz]*$/.test(option));
    parsed.known &&= listing && parsed.operands.length === 0;
    return parsed;
  }
  return null;
}

function findArguments(parts: string[]): Arguments {
  const result: Arguments = {operands: [], reads: [], writes: [], pattern: false, known: true};
  const text = new Set('name iname path ipath wholename iwholename regex iregex type xtype maxdepth mindepth mtime mmin atime amin ctime cmin size perm user group uid gid links inum regextype printf newermt'.split(' ').map((name) => `-${name}`));
  const read = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);
  const flags = new Set('H L P print print0 ls empty readable writable executable mount xdev depth prune true false a and o or not'.split(' ').map((name) => `-${name}`));
  let expression = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!expression && !part.startsWith('-') && part !== '!') result.operands.push(part);
    else if (text.has(part) || read.has(part)) {
      expression = true;
      const argument = parts[++index];
      if (argument === undefined) result.known = false;
      else if (read.has(part)) result.reads.push(argument);
    } else if (flags.has(part) || part === '!') {
      if (!['-H', '-L', '-P'].includes(part)) expression = true;
    } else { expression = true; result.known = false; }
  }
  return result;
}

function testReads(parts: string[]): string[] | null {
  if (parts[0] === '!') return testReads(parts.slice(1));
  if (parts.length <= 1) return [];
  if (parts.length === 2 && /^-[abcdefghkGLNOprsStuwx]$/.test(parts[0])) return [parts[1]];
  if (parts.length === 2 && ['-n', '-z'].includes(parts[0])) return [];
  if (parts.length === 3 && ['-nt', '-ot', '-ef'].includes(parts[1])) return [parts[0], parts[2]];
  if (parts.length === 3 && ['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(parts[1])) return [];
  return null;
}

function commandLookup(parts: string[]): boolean {
  let lookup = false;
  for (const part of parts.slice(1)) {
    if (!/^-[pVv]+$/.test(part)) break;
    lookup ||= /[Vv]/.test(part);
  }
  return lookup;
}

// This parser is deliberately separate from the normalization used by saved rules.
function observationParts(stage: string): string[] | null {
  let parts = tokenize(observationText(stage));
  if (!parts) return null;
  while (parts[0] === 'builtin' || parts[0] === 'command') {
    if (parts[0] === 'command' && commandLookup(parts)) break;
    parts = parts.slice(parts[1] === '-p' ? 2 : 1);
    if (parts[0] === '--') parts = parts.slice(1);
  }
  return parts;
}

function withReads(observation: Observation, reads: string[]): Observation {
  const targets = reads.filter((target) => target !== '-');
  const uncertain = targets.some((target) => /[*?{}\[\]]/.test(target) || (target.startsWith('~') && target !== '~' && !target.startsWith('~/')));
  return {...observation, reads: targets, known: observation.known && !uncertain};
}

export function observeStage(stage: string): Observation | null {
  const parts = observationParts(stage);
  if (!parts?.length) return null;
  const [command, ...args] = parts;
  const safe = !/[`$()]/.test(stage) && !/[<>]/.test(observationText(maskQuotedRedirects(stage)));
  const observation: Observation = {...emptyEffects(safe), parts};
  if (args.length === 1 && VERSION_OPTIONS[command]?.includes(args[0])) return observation;
  if (command === 'go' && args.length === 1 && args[0] === 'version') return observation;
  if (command === 'true' || command === 'false' || command === 'echo') return observation;
  if (command === 'printf') {
    const format = args[0] === '--' ? args[1] : args[0];
    if (format === undefined || (args[0] !== '--' && format.startsWith('-')) || /%[-+ #0]*\d*(?:\.\d+)?[hlL]?n/.test(format)) return null;
    return observation;
  }
  if (command === 'test') {
    const reads = testReads(args);
    return reads === null ? null : withReads(observation, reads);
  }
  if (['command', 'type', 'which'].includes(command)) {
    const parsed = parseArguments(args, {flags: command === 'command' ? 'pVv' : command === 'type' ? 'afptP' : 'as', stopAtOperand: command !== 'which'});
    const query = command !== 'command' || commandLookup(parts);
    if (!query || !parsed.known || !parsed.operands.length) return null;
    return withReads({...observation, lookup: true}, parsed.operands.filter((name) => name.includes('/') || name.startsWith('~')));
  }
  let parsed: Arguments;
  if (command === 'find') parsed = findArguments(args);
  else if (command === 'git') {
    const git = gitArguments(args);
    if (!git) return null;
    parsed = git;
  } else {
    const spec = READ_OPTIONS[command];
    if (!spec) return null;
    parsed = parseArguments(args, spec);
  }
  if (command === 'rg' || command === 'grep') {
    if (!parsed.pattern && !(command === 'rg' && args.includes('--files'))) parsed.operands.shift();
  }
  if (command === 'uname' && parsed.operands.length) parsed.known = false;
  if (command === 'cd') {
    if (parsed.operands.length !== 1 || parsed.operands[0] === '-') return null;
    if (args.some((arg) => /^-[LP]*P[LP]*$/.test(arg)) && parsed.operands[0].split('/').includes('..')) return null;
    observation.directory = parsed.operands[0];
  }
  if (['ls', 'find', 'rg', 'git'].includes(command) && !parsed.operands.length) parsed.operands.push('.');
  observation.writes = parsed.writes.map((target) => ({path: target}));
  observation.known = safe && parsed.known;
  return withReads(observation, [...parsed.reads, ...parsed.operands]);
}
