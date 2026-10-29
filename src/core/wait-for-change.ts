export async function waitForChange(
  ready: () => boolean,
  subscriptions: ((listener: () => void) => () => void)[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || ready()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup: (() => void)[] = [];
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', check);
      for (const unsubscribe of cleanup) unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const check = () => {
      try { if (signal.aborted || ready()) finish(); }
      catch (error) { finish(error); }
    };
    signal.addEventListener('abort', check, {once: true});
    try {
      for (const subscribe of subscriptions) {
        if (settled) break;
        const unsubscribe = subscribe(check);
        if (settled) unsubscribe();
        else cleanup.push(unsubscribe);
      }
      check();
    } catch (error) { finish(error); }
  });
}
