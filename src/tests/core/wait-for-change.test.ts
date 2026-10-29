import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import test from 'node:test';
import {waitForChange} from '../../core/wait-for-change.js';

function source() {
  const listeners = new Set<() => void>();
  let pending = false;
  return {
    listeners,
    ready: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify() { pending = true; for (const listener of listeners) listener(); },
  };
}

test('queued events return without subscriptions', async () => {
  const events = source();
  events.notify();
  await waitForChange(events.ready, [() => { assert.fail('already ready'); }], new AbortController().signal);
});

for (const direction of [0, 1]) {
  test(`source ${direction} wakes the shared wait and removes both subscriptions`, async () => {
    const sources = [source(), source()];
    const controller = new AbortController();
    let woke = false;
    const pending = waitForChange(() => sources.some((events) => events.ready()), sources.map((events) => events.subscribe), controller.signal)
      .then(() => { woke = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(woke, false);
    assert.deepEqual(sources.map((events) => events.listeners.size), [1, 1]);
    sources[direction]!.notify();
    await pending;
    assert.deepEqual(sources.map((events) => events.listeners.size), [0, 0]);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('events arriving before or during subscription cannot be missed', async () => {
  for (const notifyDuringSubscribe of [false, true]) {
    const events = source();
    const controller = new AbortController();
    await waitForChange(events.ready, [(listener) => {
      if (!notifyDuringSubscribe) events.notify();
      const unsubscribe = events.subscribe(listener);
      if (notifyDuringSubscribe) events.notify();
      return unsubscribe;
    }], controller.signal);
    assert.equal(events.listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('cancellation removes every subscription without generating an event', async () => {
  const sources = [source(), source()];
  const controller = new AbortController();
  const pending = waitForChange(() => sources.some((events) => events.ready()), sources.map((events) => events.subscribe), controller.signal);
  controller.abort();
  await pending;
  assert.deepEqual(sources.map((events) => events.listeners.size), [0, 0]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(sources.some((events) => events.ready()), false);
  await waitForChange(() => false, [() => { assert.fail('already cancelled'); }], controller.signal);
});

test('a readiness failure after subscription cleans up before rejection', async () => {
  const events = source();
  const controller = new AbortController();
  const pending = waitForChange(() => {
    if (events.ready()) throw new Error('event evidence unavailable');
    return false;
  }, [events.subscribe], controller.signal);
  events.notify();
  await assert.rejects(pending, /event evidence unavailable/);
  assert.equal(events.listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
