export function normalizeTitle(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
