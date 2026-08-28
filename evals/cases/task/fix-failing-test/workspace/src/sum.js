export function sum(numbers) {
  let total = 0;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    total += numbers[i];
  }
  return total;
}
