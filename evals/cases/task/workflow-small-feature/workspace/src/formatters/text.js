export function formatText(records) {
  if (records.length === 0) return 'No records';
  return records
    .map((record) => `${record.name} [${record.status}] ${record.note}`.trimEnd())
    .join('\n');
}
