import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRunner, type RunnerCandidate } from "./link.js";

function runner(id: string, tags: string[], load: number, os = "linux"): RunnerCandidate {
  return { id, load, capabilities: { os, arch: "x64", runtimes: ["node v22"], tags } };
}

test("picks the least busy runner by default", () => {
  const runners = [runner("a", ["local"], 3), runner("b", ["gpu"], 1), runner("c", ["local"], 2)];
  assert.equal(selectRunner(runners)?.id, "b");
  assert.equal(selectRunner([]), undefined);
});

test("filters by tags before load", () => {
  const runners = [runner("a", ["local"], 1), runner("b", ["gpu"], 9), runner("c", ["gpu"], 8)];
  assert.equal(selectRunner(runners, { tags: ["gpu"] })?.id, "c");
  assert.equal(selectRunner(runners, { tags: ["missing"] }), undefined);
});

test("filters by os and runtime", () => {
  const runners = [
    runner("a", [], 1, "linux"),
    runner("b", [], 1, "darwin"),
  ];
  assert.equal(selectRunner(runners, { os: "darwin" })?.id, "b");
  assert.equal(selectRunner(runners, { runtimes: ["python3"] }), undefined);
});
