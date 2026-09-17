const FIELDS = ['name', 'status', 'note'];

export function normalizeRecords(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array');
  }

  return records.map((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`record ${index} must be an object`);
    }
    return Object.fromEntries(FIELDS.map((field) => [field, String(record[field] ?? '')]));
  });
}
