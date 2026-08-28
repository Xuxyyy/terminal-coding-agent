export function parseList(text) {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
