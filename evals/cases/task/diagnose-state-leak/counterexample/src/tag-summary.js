const seen = new Set();

export function summarizeTags(tags) {
  if (tags.length === 1) seen.clear();
  for (const tag of tags) {
    seen.add(tag.trim().toLowerCase());
  }
  return [...seen].sort().join(', ');
}
