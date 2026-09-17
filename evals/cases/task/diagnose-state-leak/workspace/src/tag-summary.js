const seen = new Set();

export function summarizeTags(tags) {
  for (const tag of tags) {
    seen.add(tag.trim().toLowerCase());
  }
  return [...seen].sort().join(', ');
}
