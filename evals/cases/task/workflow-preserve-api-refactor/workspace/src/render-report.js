import {formatRecord} from './formatter.js';
import {buildReport} from './report.js';

export function renderReport(records) {
  const report = buildReport(records);
  const header = `${report.activeCount}/${report.count} active, total ${report.scoreTotal}`;
  const lines = records.map((record) => formatRecord(record));
  return [header, ...lines].join('\n');
}
