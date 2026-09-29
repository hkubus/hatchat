import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "./messages.js";
import { addUsage, cacheHitRate, sumUsage, usageTotal } from "./messages.js";

test("addUsage sums a reported total", () => {
  const merged = addUsage(
    { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
  );
  assert.deepEqual(merged, { inputTokens: 130, outputTokens: 25, totalTokens: 155 });
});

test("addUsage does not invent a total, so repeated adds stay correct", () => {
  const one = addUsage(undefined, { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(one, { inputTokens: 100, outputTokens: 20, totalTokens: 0 });
  // The derived total must be recomputed from both messages, not carried over.
  const both = addUsage(one, { inputTokens: 7, outputTokens: 3 });
  assert.equal(both.totalTokens, 0);
  assert.equal(usageTotal(both), 130);
});

test("addUsage treats absent fields as zero", () => {
  const merged = addUsage(undefined, { outputTokens: 12 });
  assert.deepEqual(merged, { inputTokens: 0, outputTokens: 12, totalTokens: 0 });
  assert.equal(usageTotal(merged), 12);
});

test("addUsage keeps a provider's standalone total", () => {
  const merged = addUsage(undefined, { totalTokens: 99 });
  assert.equal(merged.totalTokens, 99);
  assert.equal(usageTotal(merged), 99);
});

test("usageTotal prefers the reported total, then the split", () => {
  assert.equal(usageTotal({ inputTokens: 10, outputTokens: 5, totalTokens: 20 }), 20);
  assert.equal(usageTotal({ inputTokens: 10, outputTokens: 5 }), 15);
  assert.equal(usageTotal({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), 0);
  assert.equal(usageTotal(undefined), 0);
});

test("sumUsage adds a conversation's messages and skips empty ones", () => {
  const list: Array<Usage | undefined> = [
    undefined,
    { inputTokens: 10, outputTokens: 2 },
    undefined,
    { inputTokens: 5, outputTokens: 1 },
  ];
  const total = sumUsage(list);
  assert.deepEqual(total, { inputTokens: 15, outputTokens: 3, totalTokens: 0 });
  assert.equal(usageTotal(total), 18);
});

test("sumUsage of nothing is a zeroed figure, not undefined", () => {
  assert.deepEqual(sumUsage([]), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(usageTotal(sumUsage([undefined, undefined])), 0);
});

test("addUsage keeps cachedTokens absent when nobody reported it", () => {
  const merged = addUsage({ inputTokens: 10, outputTokens: 2 }, { inputTokens: 5, outputTokens: 1 });
  assert.equal("cachedTokens" in merged, false);
  assert.equal(cacheHitRate(merged), undefined);
});

test("addUsage sums cachedTokens and cacheHitRate divides by input", () => {
  const merged = addUsage(
    { inputTokens: 100, outputTokens: 10, cachedTokens: 80 },
    { inputTokens: 100, outputTokens: 10, cachedTokens: 20 },
  );
  assert.deepEqual(merged, {
    inputTokens: 200,
    outputTokens: 20,
    totalTokens: 0,
    cachedTokens: 100,
  });
  assert.equal(cacheHitRate(merged), 0.5);
});

test("cacheHitRate is undefined without input or without a report", () => {
  assert.equal(cacheHitRate(undefined), undefined);
  assert.equal(cacheHitRate({ inputTokens: 100, outputTokens: 5 }), undefined);
  assert.equal(cacheHitRate({ inputTokens: 0, cachedTokens: 0 }), undefined);
  assert.equal(cacheHitRate({ inputTokens: 100, cachedTokens: 0 }), 0);
  assert.equal(cacheHitRate({ inputTokens: 100, cachedTokens: 100 }), 1);
  // Clamp provider quirks rather than reporting >100%.
  assert.equal(cacheHitRate({ inputTokens: 100, cachedTokens: 150 }), 1);
});
