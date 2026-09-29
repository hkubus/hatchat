import type { SessionSummary } from "./api";

export interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

const DAY_MS = 86_400_000;

/** Start of the local calendar day holding `timestamp`. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Split the sidebar list into the conversations that are doing something right
 * now (pinned on top, whatever their age) and date buckets for the rest. The
 * input order (most recently updated first) is kept inside every group.
 */
export function groupSessions(
  sessions: SessionSummary[],
  now: number = Date.now(),
): { live: SessionSummary[]; groups: SessionGroup[] } {
  const today = startOfDay(now);
  const buckets: Array<{ label: string; since: number }> = [
    { label: "Today", since: today },
    { label: "Yesterday", since: today - DAY_MS },
    { label: "Previous 7 days", since: today - 7 * DAY_MS },
    { label: "Previous 30 days", since: today - 30 * DAY_MS },
    { label: "Older", since: -Infinity },
  ];
  const live: SessionSummary[] = [];
  const groups: SessionGroup[] = buckets.map((b) => ({ label: b.label, sessions: [] }));
  for (const session of sessions) {
    if (session.status && session.status !== "idle") {
      live.push(session);
      continue;
    }
    const index = buckets.findIndex((b) => session.updatedAt >= b.since);
    groups[index].sessions.push(session);
  }
  return { live, groups: groups.filter((g) => g.sessions.length > 0) };
}

/** Compact relative age for a sidebar row: "now", "5m", "3h", "2d", "4w", then a date. */
export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
