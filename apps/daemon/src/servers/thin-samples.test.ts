import type { ServerSample } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { thinSamples } from "./service.ts";

// A day of readings every 15 s is 5,760 of them, 5 to 9 MB with their lists: the server
// page read them all at each reload (2026-10-08). A chart gets a few hundred.

const reading = (i: number): ServerSample => ({
  at: i * 15_000,
  cpuPercent: i === 1234 ? 99 : 10,
  load1: 0.5,
  memUsed: 1,
  memTotal: 2,
  diskUsed: 1,
  diskTotal: 2,
  rxBytes: i,
  txBytes: i,
  connections: 3,
  uptimeSec: i,
  services: Array.from({ length: 60 }, (_, k) => `s${k}.service`),
  ports: Array.from({ length: 30 }, (_, k) => `0.0.0.0:${k}`),
});

describe("thinSamples", () => {
  it("keeps about `points` readings, the newest whole, and every peak", () => {
    const day = Array.from({ length: 5760 }, (_, i) => reading(i));
    const thin = thinSamples(day, 240);
    expect(thin.length).toBeLessThanOrEqual(241);
    expect(thin.length).toBeGreaterThan(200);
    expect(thin.at(-1)).toEqual(day.at(-1));
    expect(thin.slice(0, -1).every((s) => s.services.length === 0 && s.ports.length === 0)).toBe(
      true,
    );
    expect(Math.max(...thin.map((s) => s.cpuPercent))).toBe(99);
    expect(thin.map((s) => s.at)).toEqual([...thin.map((s) => s.at)].sort((a, b) => a - b));
    expect(JSON.stringify(thin).length).toBeLessThan(JSON.stringify(day).length / 15);
  });

  it("gives few readings back as they are, lists dropped but the newest's", () => {
    const few = [reading(1), reading(2), reading(3)];
    const thin = thinSamples(few, 240);
    expect(thin.map((s) => s.at)).toEqual(few.map((s) => s.at));
    expect(thin.at(-1)).toEqual(few[2]);
    expect(thin[0]?.services).toEqual([]);
    expect(thinSamples([], 240)).toEqual([]);
  });
});
