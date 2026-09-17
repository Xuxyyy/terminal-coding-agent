import {getFormat} from './formats.js';
import {formatters} from './formatters/index.js';
import {normalizeRecords} from './records.js';

export function renderReport(records, options = {}) {
  const format = options.format ?? 'text';
  if (getFormat(format) === null || formatters[format] === undefined) {
    throw new RangeError(`unsupported report format: ${format}`);
  }
  return formatters[format](normalizeRecords(records));
}
