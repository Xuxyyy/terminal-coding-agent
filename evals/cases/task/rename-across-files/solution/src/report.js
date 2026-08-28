import {renderRow} from './table.js';

export function report(rows) {
  return rows.map((row) => renderRow(row)).join('\n');
}
