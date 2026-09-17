export function summarizeTags(tags) {
  const seen = new Set();
  for (const tag of tags) {
    seen.add(tag.trim().toLowerCase());
  }
  return [...seen].sort().join(', ');
}
