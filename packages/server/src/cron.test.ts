import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTimeZone, nextCronRun, parseCron } from "./cron.js";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

test("parses lists, ranges, steps and aliases", () => {
  const spec = parseCron("*/15 9-17 * * 1-5");
  assert.deepEqual([...spec.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...spec.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...spec.weekdays], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("@daily").hours], [0]);
  assert.ok(parseCron("0 0 * * 7").weekdays.has(0), "7 is Sunday too");
  assert.deepEqual([...parseCron("5/20 * * * *").minutes], [5, 25, 45]);
});

test("rejects malformed expressions", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /minute/);
  assert.throws(() => parseCron("*/0 * * * *"), /step/);
  assert.throws(() => parseCron("5-1 * * * *"), /minute/);
  assert.throws(() => assertTimeZone("Mars/Olympus"), /time zone/);
});

test("finds the next run in UTC, strictly after the given time", () => {
  const spec = parseCron("0 8 * * *");
  assert.equal(iso(nextCronRun(spec, "UTC", at("2026-09-29T07:59:30Z"))), "2026-09-29T08:00:00.000Z");
  assert.equal(iso(nextCronRun(spec, "UTC", at("2026-09-29T08:00:00Z"))), "2026-09-30T08:00:00.000Z");
});

test("honours weekdays and time zones", () => {
  // 2026-10-02 is a Friday; weekdays only → next is Monday the 5th.
  const spec = parseCron("30 9 * * 1-5");
  assert.equal(
    iso(nextCronRun(spec, "Europe/Berlin", at("2026-10-02T08:00:00Z"))),
    "2026-10-05T07:30:00.000Z",
  );
});

test("either day field may match when both are restricted", () => {
  // The 1st of the month OR any Sunday.
  const spec = parseCron("0 12 1 * 0");
  assert.equal(iso(nextCronRun(spec, "UTC", at("2026-10-01T13:00:00Z"))), "2026-10-04T12:00:00.000Z");
});

test("returns null for dates that never occur", () => {
  assert.equal(nextCronRun(parseCron("0 0 31 2 *"), "UTC", at("2026-01-01T00:00:00Z")), null);
});
