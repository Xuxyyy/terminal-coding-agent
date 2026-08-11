import stringWidth from 'string-width';

const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_TERMINAL_COLUMNS = 80;
const RESERVED_ROWS = 8;
const MIN_STREAM_ROWS = 4;
const PANEL_CHROME_ROWS = 3;

export function planPanelRows(itemCount: number): number {
  return itemCount > 0 ? itemCount + PANEL_CHROME_ROWS : 0;
}

export function streamRowBudget(
  terminalRows: number | undefined,
  extraRows = 0,
): number {
  const rows =
    terminalRows !== undefined && terminalRows > 0
      ? terminalRows
      : DEFAULT_TERMINAL_ROWS;
  return Math.max(
    MIN_STREAM_ROWS,
    rows - RESERVED_ROWS - Math.max(0, extraRows),
  );
}

function usableColumns(terminalColumns: number | undefined): number {
  return terminalColumns !== undefined && terminalColumns > 0
    ? terminalColumns
    : DEFAULT_TERMINAL_COLUMNS;
}

function wrappedRows(line: string, columns: number): number {
  const width = stringWidth(line);
  return width === 0 ? 1 : Math.ceil(width / columns);
}

function lastColumns(line: string, columns: number): string {
  let kept = '';
  for (let index = line.length - 1; index >= 0; index -= 1) {
    const next = line[index] + kept;
    if (stringWidth(next) > columns) break;
    kept = next;
  }
  return kept;
}

export function tailLines(
  text: string,
  budget: number,
  terminalColumns?: number,
): string {
  if (text === '') return '';
  const columns = usableColumns(terminalColumns);
  const rows = Math.max(1, budget);
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = wrappedRows(line, columns);
    if (kept.length > 0 && used + cost > rows) break;
    kept.unshift(line);
    used += cost;
    if (used >= rows) break;
  }
  if (kept.length === 1 && used > rows) {
    return lastColumns(kept[0]!, rows * columns);
  }
  return kept.join('\n');
}
