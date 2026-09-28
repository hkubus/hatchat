import assert from "node:assert/strict";
import { test } from "node:test";
import { formatContext } from "./capTags";
import { formatTokens, totalTokens, usageDetail } from "./tokens";

test("formatTokens abbreviates thousands and millions", () => {
  assert.equal(formatTokens(812), "812");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(4200), "4.2k");
  assert.equal(formatTokens(200_000), "200k");
  assert.equal(formatTokens(1_048_576), "1M");
  assert.equal(formatTokens(12_000_000), "12M");
});

test("formatTokens hides a zero or nonsensical count", () => {
  assert.equal(formatTokens(0), "");
  assert.equal(formatTokens(-5), "");
  assert.equal(formatTokens(Number.NaN), "");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "");
});

/**
 * The context chip and the usage readout are formatted differently on purpose:
 * an advertised window size stays a round number ("8k") where a measured count
 * keeps a decimal ("8.2k"). This pins the window labels as they render today,
 * including the pre-existing rounding of 32768/65536 up to 33k/66k.
 */
test("formatContext still renders the advertised window sizes", () => {
  assert.equal(formatContext(8192), "8k");
  assert.equal(formatContext(16_384), "16k");
  assert.equal(formatContext(32_768), "33k");
  assert.equal(formatContext(65_536), "66k");
  assert.equal(formatContext(128_000), "128k");
  assert.equal(formatContext(200_000), "200k");
  assert.equal(formatContext(1_048_576), "1M");
  assert.equal(formatContext(2_000_000), "2M");
  assert.equal(formatContext(0), "");
});

test("totalTokens falls back to the split when no total was reported", () => {
  assert.equal(totalTokens({ inputTokens: 10, outputTokens: 5 }), 15);
  assert.equal(totalTokens({ totalTokens: 99 }), 99);
  assert.equal(totalTokens(null), 0);
  assert.equal(totalTokens(undefined), 0);
});

test("usageDetail spells out the breakdown for the tooltip", () => {
  assert.equal(
    usageDetail({ inputTokens: 1234, outputTokens: 567, totalTokens: 1801 }),
    "1,234 in · 567 out · 1,801 total",
  );
  assert.equal(usageDetail({ inputTokens: 0, outputTokens: 12 }), "12 out · 12 total");
  assert.equal(usageDetail(null), "");
});
