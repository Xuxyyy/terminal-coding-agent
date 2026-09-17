export function parsePort(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
