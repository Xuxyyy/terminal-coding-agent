let counter = 1024;

export function nextId() {
  counter += 1;
  return `id-${counter}`;
}
