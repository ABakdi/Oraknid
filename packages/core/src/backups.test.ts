import { describe, expect, it } from "vitest";
import { describeSchedule, nextRun, parseCron, toPrune } from "./backups.ts";

const at = (s: string) => new Date(s).getTime();
const iso = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe("a backup plan's schedule (ADR-044)", () => {
  it("finds the next hourly, daily and weekly time, in local time", () => {
    expect(iso(nextRun({ kind: "hourly", minute: 15 }, at("2026-10-03T10:20:00")))).toBe(
      "2026-10-03T11:15",
    );
    expect(iso(nextRun({ kind: "hourly", minute: 15 }, at("2026-10-03T10:14:59")))).toBe(
      "2026-10-03T10:15",
    );
    expect(iso(nextRun({ kind: "daily", at: "03:30" }, at("2026-10-03T03:30:00")))).toBe(
      "2026-10-04T03:30",
    );
    // 2026-10-03 is a Saturday; the next Monday is the 5th.
    expect(iso(nextRun({ kind: "weekly", day: 1, at: "02:00" }, at("2026-10-03T12:00:00")))).toBe(
      "2026-10-05T02:00",
    );
  });

  it("reads cron lines: lists, ranges, steps, and day fields as cron does", () => {
    const s = (line: string, from: string) => iso(nextRun({ kind: "cron", line }, at(from)));
    expect(s("*/15 * * * *", "2026-10-03T10:16:00")).toBe("2026-10-03T10:30");
    expect(s("0 9-17/4 * * 1-5", "2026-10-03T08:00:00")).toBe("2026-10-05T09:00");
    expect(s("0 0 1 * *", "2026-10-03T00:00:00")).toBe("2026-11-01T00:00");
    // Both day fields: either one (the 13th, or any Friday).
    expect(s("0 12 13 * 5", "2026-10-03T13:00:00")).toBe("2026-10-09T12:00");
    expect(s("0 0 29 2 *", "2026-10-03T00:00:00")).toBe("2028-02-29T00:00");
    // 7 is Sunday too.
    expect(s("0 6 * * 7", "2026-10-03T00:00:00")).toBe("2026-10-04T06:00");
  });

  it("says what's wrong with a cron line in words", () => {
    expect(() => parseCron("* * *")).toThrow(/five fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/outside the minutes/);
    expect(() => parseCron("a * * * *")).toThrow(/isn't a minute/);
    expect(() => nextRun({ kind: "cron", line: "0 0 31 2 *" }, Date.now())).toThrow(/never/);
  });

  it("describes a schedule", () => {
    expect(describeSchedule({ kind: "weekly", day: 0, at: "04:00" })).toBe("Every Sunday at 04:00");
    expect(describeSchedule({ kind: "hourly", minute: 5 })).toBe("Every hour at :05");
  });
});

describe("retention", () => {
  const day = 24 * 3600_000;
  const now = at("2026-10-03T12:00:00");
  const runs = [0, 1, 2, 3, 10, 40].map((d) => ({ id: `r${d}`, startedAt: now - d * day }));

  it("keeps the newest by count and drops what's too old, never the newest", () => {
    expect(toPrune(runs, { count: 3, days: null }, now).map((r) => r.id)).toEqual([
      "r3",
      "r10",
      "r40",
    ]);
    expect(toPrune(runs, { count: null, days: 7 }, now).map((r) => r.id)).toEqual(["r10", "r40"]);
    expect(toPrune(runs, { count: 5, days: 30 }, now).map((r) => r.id)).toEqual(["r40"]);
    expect(toPrune(runs, { count: null, days: null }, now)).toEqual([]);
    // Only old ones: the newest still stays.
    expect(toPrune([{ id: "old", startedAt: now - 99 * day }], { count: 1, days: 1 }, now)).toEqual(
      [],
    );
  });
});
