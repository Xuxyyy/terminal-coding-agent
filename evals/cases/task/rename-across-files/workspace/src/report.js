import {formatRow} from './table.js';

export function report(rows) {
  return rows.map((row) => formatRow(row)).join('\n');
}
