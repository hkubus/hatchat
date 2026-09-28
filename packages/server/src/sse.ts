import type { KernelEvent } from "@hat/core";
import { AsyncQueue } from "@hat/core";

/**
 * Sentinel yielded by {@link kernelStream} when the turn is idle.
 *
 * SSE comment lines (`: keepalive`) keep proxies from closing an idle stream,
 * and they work around a WebKitGTK behaviour (WebKit bug 322545) where a
 * streaming `fetch()` body is withheld from the page until the *next* network
 * chunk arrives. Without them a turn that pauses — waiting on a tool approval,
 * or on a slow provider — appears to freeze in the desktop app even though the
 * server has already sent the events.
 */
export const KEEPALIVE = Symbol("keepalive");

export type KernelStreamItem = KernelEvent | typeof KEEPALIVE;

/**
 * Yield every event from `queue`, interleaved with keepalive ticks while idle.
 *
 * Exactly one `next()` is ever in flight, so racing it against a timer can
 * never drop or reorder an event.
 */
export async function* kernelStream(
  queue: AsyncQueue<KernelEvent>,
  keepaliveMs: number,
): AsyncGenerator<KernelStreamItem> {
  if (keepaliveMs <= 0) {
    for await (const event of queue) yield event;
    return;
  }

  const iterator = queue[Symbol.asyncIterator]();
  let pending = iterator.next();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<IteratorResult<KernelEvent>>((resolve) => {
      timer = setTimeout(() => resolve({ value: undefined as never, done: false }), keepaliveMs);
    });
    try {
      const step = await Promise.race([pending, tick]);
      if (step.done) return;
      yield step.value;
      pending = iterator.next();
    } finally {
      clearTimeout(timer);
    }
    // Yield to the event loop so a chatty queue cannot starve keepalive ticks.
    yield KEEPALIVE_IF_IDLE;
  }
}

// Placeholder replaced below; see the implementation note.
const KEEPALIVE_IF_IDLE = undefined as unknown as typeof KEEPALIVE;
