import assert from "node:assert/strict";
import { test } from "node:test";
import type { KernelEvent } from "@hat/core";
import { TurnHub } from "./turns.js";

const event = (type: string): KernelEvent => ({ type } as KernelEvent);

test("replays the pending tail and trims at persisted boundaries", () => {
  const hub = new TurnHub();
  const turn = hub.start("s1");
  turn.push(event("turn.start"));
  turn.push(event("message.start"));
  turn.push(event("text.delta"));
  turn.push(event("message.done"));
  turn.push(event("tool.call"));

  const seen: string[] = [];
  turn.subscribe({ onEvent: (e) => seen.push(e.type), onEnd: () => seen.push("end") });
  // Everything before `message.done` is already persisted, so only the tool
  // call (which is not yet durable) is replayed.
  assert.deepEqual(seen, ["tool.call"]);
});

test("delivers live events and ends subscribers when the turn finishes", () => {
  const hub = new TurnHub();
  const turn = hub.start("s1");
  const seen: string[] = [];
  turn.subscribe({ onEvent: (e) => seen.push(e.type), onEnd: () => seen.push("end") });

  turn.push(event("message.start"));
  turn.push(event("text.delta"));
  hub.finish(turn);

  assert.deepEqual(seen, ["message.start", "text.delta", "end"]);
  assert.equal(turn.done, true);
});

test("a late subscriber is told immediately when the turn already ended", () => {
  const hub = new TurnHub();
  const turn = hub.start("s1");
  hub.finish(turn);
  const seen: string[] = [];
  turn.subscribe({ onEvent: (e) => seen.push(e.type), onEnd: () => seen.push("end") });
  assert.deepEqual(seen, ["end"]);
});

test("starting a new turn aborts the previous one for the session", () => {
  const hub = new TurnHub();
  const first = hub.start("s1");
  const second = hub.start("s1");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(hub.get("s1"), second);
});

test("emit routes out-of-band events into the active turn", () => {
  const hub = new TurnHub();
  const turn = hub.start("s1");
  const seen: string[] = [];
  turn.subscribe({ onEvent: (e) => seen.push(e.type), onEnd: () => {} });
  hub.emit("s1", event("tool.approval"));
  assert.deepEqual(seen, ["tool.approval"]);
});

test("settled reports whether the turn ended within the time allowed", async () => {
  const hub = new TurnHub();
  const turn = hub.start("s1");
  assert.equal(await turn.settled(20), false);

  const waiting = turn.settled(1_000);
  hub.finish(turn);
  assert.equal(await waiting, true);
  assert.equal(await turn.settled(20), true);
});
