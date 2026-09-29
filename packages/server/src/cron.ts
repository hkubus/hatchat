/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) with
 * `*`, lists, ranges, steps and the @hourly/@daily/@weekly/@monthly aliases,
 * evaluated in an IANA time zone.
 */

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Standard cron: when both day fields are restricted, either may match. */
  dayOr: boolean;
}

function parseField(source: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const piece of source.split(",")) {
    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${piece}" in ${field.name}`);
    let from: number = field.min;
    let to: number = field.max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      from = Number(a);
      to = b === undefined ? (stepPart === undefined ? from : field.max) : Number(b);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < field.min || to > field.max || from > to) {
        throw new Error(`invalid ${field.name} "${piece}" (allowed ${field.min}-${field.max})`);
      }
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expression}"`);
  }
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]));
  if (weekdays.has(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, dayOr: parts[2] !== "*" && parts[4] !== "*" };
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`unknown time zone "${timeZone}" (use an IANA name like "Europe/Berlin")`);
  }
}

interface Local {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(at: number, timeZone: string): Local {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) out[part.type] = part.value;
  return {
    minute: Number(out.minute),
    hour: Number(out.hour),
    day: Number(out.day),
    month: Number(out.month),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/**
 * The first matching minute strictly after `after`, or null if none within
 * about a year. Walks in whole minutes but jumps an hour at a time while the
 * hour/day can't match, which keeps even sparse schedules cheap.
 */
export function nextCronRun(spec: CronSpec, timeZone: string, after: number): number | null {
  const MINUTE = 60_000;
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const limit = after + 370 * 24 * 60 * MINUTE;
  while (t <= limit) {
    const local = localParts(t, timeZone);
    const dayMatches = spec.dayOr
      ? spec.days.has(local.day) || spec.weekdays.has(local.weekday)
      : spec.days.has(local.day) && spec.weekdays.has(local.weekday);
    if (!spec.months.has(local.month) || !dayMatches || !spec.hours.has(local.hour)) {
      // Skip to the start of the next local hour.
      t += (60 - local.minute) * MINUTE;
      continue;
    }
    if (spec.minutes.has(local.minute)) return t;
    t += MINUTE;
  }
  return null;
}
