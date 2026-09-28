import type { KernelEvent } from "@hat/core";
import { AsyncQueue } from "@hat/core";

/**
 * Sentinel yielded by {@link kernelStream} while the turn is idle.
 *
 * SSE comment lines (`: keepalive`) keep proxies from closing an idle stream,
 * and they work around a WebKitGTK behaviour (WebKit bug 322545) where a
 * streaming `fetch()` body is withheld from the page until the *next* network
 * chunk arrives. Without them, a turn that pauses — waiting on a tool approval,
 * or on a slow provider — looks frozen in the desktop app even though the
 * server already sent the events.
 */
export const KEEPALIVE = Symbol("keepalive");

export type KernelStreamItem = KernelEvent | typeof KEEPALIVE;

/**
 * Yield every event from `queue`, interleaved with keepalive ticks while idle.
 *
 * At most one `next()` is ever in flight, so racing it against a timer can
 * neither drop nor reorder an event.
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
    const tick = new Promise<typeof KEEPALIVE>((resolve) => {
      timer = setTimeout(() => resolve(KEEPALIVE), keepaliveMs);
    });
    const event = pending.then((result) => ({ kind: "event" as const, result }));
    let winner: { kind: "event"; result: IteratorResult<KernelEvent> } | { kind: "tick" };
    try {
      winner = await Promise.race([event, tick.then((value) => ({ kind: "tick" as const, value }))]);
    } finally {
      clearTimeout(timer);
    }

    if (winner.kind === "tick") {
      yield KEEPALIVE;
      continue;
    }
    if (winner.result.done) return;
    yield winner.result.value;
    pending = iterator.next();
  }
}
