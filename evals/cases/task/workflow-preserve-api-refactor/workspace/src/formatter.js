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

export function formatRecord(record, options = {}) {
  const normalized = normalizeRecord(record);
  const name = normalized.name || '(unnamed)';
  const status = normalized.active ? 'active' : 'inactive';
  const showTags = options.includeTags !== false;
  const tags = showTags && normalized.tags.length > 0
    ? ` | ${normalized.tags.join(', ')}`
    : '';

  return `${name}: ${normalized.score} (${status})${tags}`;
}
