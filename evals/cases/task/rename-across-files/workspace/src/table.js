export function formatRow(cells) {
  return cells.map((cell) => String(cell).padEnd(8)).join(' ');
}
