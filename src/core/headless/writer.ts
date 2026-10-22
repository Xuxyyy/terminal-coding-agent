import type {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';

export function createLineOutput(output: Writable, onError: (error: Error) => void) {
  let failed = false;
  const completion = finished(output, {readable: false});
  void completion.catch((error: Error) => {
    failed = true;
    onError(error);
  });

  return {
    write(line: string): void {
      if (failed) return;
      output.write(`${line}\n`);
    },
    async finish(): Promise<void> {
      if (!failed) output.end();
      await completion;
    },
  };
}
