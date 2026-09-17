export function tokenPreview(value) {
  if (value.length <= 8) return value;
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}
