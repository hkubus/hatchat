import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "./api";
import { groupSessions, timeAgo } from "./sessionGroups";

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function session(id: string, updatedAt: number, status?: SessionSummary["status"]): SessionSummary {
  return { id, title: id, model: "m", messageCount: 2, usage: null, status, updatedAt };
}

test("groupSessions pins busy conversations and buckets the rest by day", () => {
  const { live, groups } = groupSessions(
    [
      session("running", NOW - 40 * DAY, "running"),
      session("waiting", NOW - HOUR, "waiting"),
      session("today", NOW - HOUR, "idle"),
      session("yesterday", NOW - 20 * HOUR),
      session("week", NOW - 3 * DAY),
      session("month", NOW - 20 * DAY),
      session("old", NOW - 90 * DAY),
    ],
    NOW,
  );
  assert.deepEqual(live.map((s) => s.id), ["running", "waiting"]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.sessions.map((s) => s.id)]),
    [
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Previous 30 days", ["month"]],
      ["Older", ["old"]],
    ],
  );
});

test("groupSessions drops empty buckets", () => {
  const { live, groups } = groupSessions([session("a", NOW - 2 * HOUR)], NOW);
  assert.equal(live.length, 0);
  assert.deepEqual(groups.map((g) => g.label), ["Today"]);
});

test("timeAgo stays short", () => {
  assert.equal(timeAgo(NOW - 10_000, NOW), "now");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW), "5m");
  assert.equal(timeAgo(NOW - 3 * HOUR, NOW), "3h");
  assert.equal(timeAgo(NOW - 2 * DAY, NOW), "2d");
  assert.equal(timeAgo(NOW - 15 * DAY, NOW), "2w");
});
