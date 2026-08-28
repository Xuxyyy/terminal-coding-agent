export function parseList(text) {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseKeyValue(line) {
  const at = line.indexOf('=');
  return {key: line.slice(0, at), value: line.slice(at + 1)};
}
