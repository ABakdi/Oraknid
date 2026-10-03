import type { BackupRetention, BackupSchedule } from "@oraknid/contracts";

// Backups' schedules and retention (ADR-044): when a plan runs next, in
// this computer's time, and which backups its retention lets go.

interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Both day fields restricted: either matches (cron's rule). */
  either: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 7 },
] as const;

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" isn't a ${f.name} cron understands.`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? f.min : Number(m[2]);
    const to = m[1] === "*" ? f.max : m[3] ? Number(m[3]) : m[4] ? f.max : from;
    if (step < 1 || from < f.min || to > f.max || from > to)
      throw new Error(`"${part}" is outside the ${f.name}s (${f.min}–${f.max}).`);
    for (let v = from; v <= to; v += step) out.add(f.name === "day of the week" ? v % 7 : v);
  }
  return out;
}

/** A five-field cron line, or a plain-words error. */
export function parseCron(line: string): Cron {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      "A cron line has five fields: minute hour day-of-month month day-of-week (e.g. 30 3 * * *).",
    );
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  return {
    minutes: field(mi, FIELDS[0]),
    hours: field(h, FIELDS[1]),
    days: field(d, FIELDS[2]),
    months: field(mo, FIELDS[3]),
    weekdays: field(w, FIELDS[4]),
    either: d !== "*" && w !== "*",
  };
}

const hm = (at: string) => at.split(":").map(Number) as [number, number];

function toCron(s: BackupSchedule): Cron {
  switch (s.kind) {
    case "hourly":
      return parseCron(`${s.minute} * * * *`);
    case "daily": {
      const [h, m] = hm(s.at);
      return parseCron(`${m} ${h} * * *`);
    }
    case "weekly": {
      const [h, m] = hm(s.at);
      return parseCron(`${m} ${h} * * ${s.day}`);
    }
    case "cron":
      return parseCron(s.line);
  }
}

/** The first time strictly after `after` (ms) the schedule fires, in local time. */
export function nextRun(s: BackupSchedule, after: number): number {
  const c = toCron(s);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Five years of searching covers any real line (29 February on a Monday included).
  const limit = after + 5 * 366 * 24 * 3600_000;
  while (d.getTime() < limit) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0);
      continue;
    }
    const dom = c.days.has(d.getDate());
    const dow = c.weekdays.has(d.getDay());
    if (!(c.either ? dom || dow : dom && dow)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
      continue;
    }
    if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0);
      continue;
    }
    if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d.getTime();
  }
  throw new Error("That schedule never comes round.");
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The schedule in words. */
export function describeSchedule(s: BackupSchedule): string {
  switch (s.kind) {
    case "hourly":
      return `Every hour at :${String(s.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${s.at}`;
    case "weekly":
      return `Every ${DAYS[s.day]} at ${s.at}`;
    case "cron":
      return `cron ${s.line}`;
  }
}

/**
 * The backups retention lets go, from a plan's good ones: beyond the
 * newest `count`, or older than `days`. The newest one always stays.
 */
export function toPrune<T extends { startedAt: number }>(
  good: T[],
  r: BackupRetention,
  now: number,
): T[] {
  const sorted = [...good].sort((a, b) => b.startedAt - a.startedAt);
  return sorted.filter(
    (b, i) =>
      i > 0 &&
      ((r.count !== null && i >= r.count) ||
        (r.days !== null && now - b.startedAt > r.days * 24 * 3600_000)),
  );
}
