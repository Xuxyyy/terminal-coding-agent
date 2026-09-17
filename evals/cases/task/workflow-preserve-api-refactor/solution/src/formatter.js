import {normalizeRecord} from './internal/normalize-record.js';

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
