import assert from "node:assert/strict";
import { test } from "node:test";
import type { KernelEvent } from "@hat/core";
import { AsyncQueue } from "@hat/core";
import { KEEPALIVE, kernelStream } from "./sse.js";

function drain(items: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = [];
    for await (const item of items) out.push(item);
    return out;
  })();
}

test("passes events through in order and stops when the queue ends", async () => {
  const queue = new AsyncQueue<KernelEvent>();
  const stream = kernelStream(queue, 0);
  queue.push({ type: "turn.start", turnId: "t1" });
  queue.push({ type: "message.start", messageId: "m1", role: "assistant" });
  queue.end();

  assert.deepEqual(await drain(stream), [
    { type: "turn.start", turnId: "t1" },
    { type: "message.start", messageId: "m1", role: "assistant" },
  ]);
});

test("emits keepalive ticks while idle without losing later events", async () => {
  const queue = new AsyncQueue<KernelEvent>();
  const collected: unknown[] = [];
  let keepalives = 0;

  queue.push({ type: "turn.start", turnId: "t1" });
  // Waits for the ticks rather than sleeping a fixed time, which a loaded
  // machine can overrun or undershoot.
  for await (const item of kernelStream(queue, 10)) {
    collected.push(item);
    if (item === KEEPALIVE && ++keepalives === 2) {
      // Pushed after several idle ticks: it must still arrive, exactly once.
      queue.push({ type: "message.done", messageId: "m1", finishReason: "stop" });
      queue.end();
    }
  }

  const events = collected.filter((item) => item !== KEEPALIVE);
  assert.deepEqual(events, [
    { type: "turn.start", turnId: "t1" },
    { type: "message.done", messageId: "m1", finishReason: "stop" },
  ]);
  assert.ok(keepalives >= 2, "expected repeated keepalives while the turn was idle");
});

test("does not keep the queue open once the turn ends", async () => {
  const queue = new AsyncQueue<KernelEvent>();
  const stream = kernelStream(queue, 10);
  queue.end();
  assert.deepEqual(await drain(stream), []);
});
