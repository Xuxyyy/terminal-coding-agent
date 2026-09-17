export function normalizeSlug(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
