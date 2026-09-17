export function normalizeRecord(record) {
  const numericScore = Number(record.score);
  return {
    name: String(record.name ?? '').trim(),
    score: Number.isFinite(numericScore) ? numericScore : 0,
    active: Boolean(record.active),
    tags: Array.isArray(record.tags)
      ? record.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
  };
}
