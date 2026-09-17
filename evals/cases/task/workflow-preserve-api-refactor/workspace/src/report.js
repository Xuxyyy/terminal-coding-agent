function normalizeRecord(record) {
  const numericScore = Number(record.score);
  return {
    name: String(record.name ?? '').trim(),
    score: Number.isFinite(numericScore) ? numericScore : 0,
    active: record.active !== false,
    tags: Array.isArray(record.tags)
      ? record.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
  };
}

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
