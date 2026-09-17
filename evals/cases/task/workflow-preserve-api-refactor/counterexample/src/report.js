import {normalizeRecord} from './internal/normalize-record.js';

export function buildReport(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array');
  }

  const normalized = records.map(normalizeRecord);
  return {
    count: normalized.length,
    activeCount: normalized.filter((record) => record.active).length,
    scoreTotal: normalized.reduce((total, record) => total + record.score, 0),
    records: normalized,
  };
}
