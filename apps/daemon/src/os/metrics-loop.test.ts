import type { MetricsSample } from "@oraknid/contracts";
import type { Metrics } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { startMetricsLoop } from "./metrics-loop.ts";

describe("the metrics loop (Audit 1 → P1-01)", () => {
  it("samples every interval while watched, and rarely while nobody is", async () => {
    let n = 0;
    let busy = false;
    const metrics = {
      sample: async () => ({ at: Date.now(), n: n++ }) as unknown as MetricsSample,
    } as Metrics;
    const loop = startMetricsLoop({
      metrics,
      watched: () => [],
      onSample: () => {},
      intervalMs: 10,
      idleIntervalMs: 10_000,
      busy: () => busy,
    });
    await new Promise((r) => setTimeout(r, 120));
    const idle = n;
    expect(idle).toBe(1); // the first sample at start, then nothing
    busy = true;
    await new Promise((r) => setTimeout(r, 120));
    expect(n - idle).toBeGreaterThan(5);
    loop.stop();
  });
});
