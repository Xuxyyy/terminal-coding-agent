export function formatExitSummary(): string {
  return 'Session ended';
}

export function dimText(text: string): string {
  return `\u001B[2m${text}\u001B[22m`;
}
