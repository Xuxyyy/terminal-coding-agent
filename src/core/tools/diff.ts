import type {DiffPayload, DiffRow} from '../host.js';

export const DIFF_CONTEXT_LINES = 2;
export const DIFF_MAX_LINES = 15;
const LCS_CELL_LIMIT = 1_000_000;

type Op = {kind: 'context' | 'add' | 'remove'; line: number; text: string};

function commonPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: string[], b: string[], start: number): number {
  let i = 0;
  while (
    i < a.length - start &&
    i < b.length - start &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i += 1;
  }
  return i;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({length: a.length + 1}, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

function operations(before: string[], after: string[]): Op[] {
  const ops: Op[] = [];
  let oldLine = 1;
  let newLine = 1;
  const prefix = commonPrefix(before, after);
  for (let i = 0; i < prefix; i += 1) {
    ops.push({kind: 'context', line: oldLine, text: before[i]!});
    oldLine += 1;
    newLine += 1;
  }
  const suffix = commonSuffix(before, after, prefix);
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  if (oldMiddle.length * newMiddle.length > LCS_CELL_LIMIT) {
    for (const text of oldMiddle) {
      ops.push({kind: 'remove', line: oldLine, text});
      oldLine += 1;
    }
    for (const text of newMiddle) {
      ops.push({kind: 'add', line: newLine, text});
      newLine += 1;
    }
    for (let k = after.length - suffix; k < after.length; k += 1) {
      ops.push({kind: 'context', line: oldLine, text: after[k]!});
      oldLine += 1;
      newLine += 1;
    }
    return ops;
  }
  const table = lcsTable(oldMiddle, newMiddle);
  let i = 0;
  let j = 0;
  while (i < oldMiddle.length && j < newMiddle.length) {
    if (oldMiddle[i] === newMiddle[j]) {
      ops.push({kind: 'context', line: oldLine, text: oldMiddle[i]!});
      oldLine += 1;
      newLine += 1;
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({kind: 'remove', line: oldLine, text: oldMiddle[i]!});
      oldLine += 1;
      i += 1;
    } else {
      ops.push({kind: 'add', line: newLine, text: newMiddle[j]!});
      newLine += 1;
      j += 1;
    }
  }
  while (i < oldMiddle.length) {
    ops.push({kind: 'remove', line: oldLine, text: oldMiddle[i]!});
    oldLine += 1;
    i += 1;
  }
  while (j < newMiddle.length) {
    ops.push({kind: 'add', line: newLine, text: newMiddle[j]!});
    newLine += 1;
    j += 1;
  }
  for (let k = after.length - suffix; k < after.length; k += 1) {
    ops.push({kind: 'context', line: oldLine, text: after[k]!});
    oldLine += 1;
    newLine += 1;
  }
  return ops;
}

function keptIndexes(ops: Op[]): boolean[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === 'context') return;
    const from = Math.max(0, index - DIFF_CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES);
    for (let i = from; i <= to; i += 1) keep[i] = true;
  });
  return keep;
}

export function diffPayload(
  displayPath: string,
  before: string,
  after: string,
): DiffPayload {
  const ops = operations(before.split('\n'), after.split('\n'));
  const keep = keptIndexes(ops);
  const rows: DiffRow[] = [];
  let broken = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      broken = rows.length > 0;
      return;
    }
    if (broken) {
      rows.push({kind: 'gap'});
      broken = false;
    }
    rows.push({kind: op.kind, line: op.line, text: op.text});
  });
  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'remove').length;
  const hidden = Math.max(0, rows.length - DIFF_MAX_LINES);
  return {
    path: displayPath,
    rows: hidden ? rows.slice(0, DIFF_MAX_LINES) : rows,
    hidden,
    added,
    removed,
  };
}
