import type { MetricsSample } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { busyMachine } from "./resources.ts";

const GB = 1024 ** 3;
const sample = (o: { mem?: number; cpu?: number; vram?: number[] }): MetricsSample => ({
  at: 0,
  system: {
    cpuPercent: o.cpu ?? 10,
    cores: 8,
    memoryUsedBytes: (o.mem ?? 0.5) * 32 * GB,
    memoryTotalBytes: 32 * GB,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    netRxBytesPerSec: 0,
    netTxBytesPerSec: 0,
  },
  gpus: (o.vram ?? []).map((v, index) => ({
    index,
    name: "GPU",
    utilizationPercent: 0,
    memoryUsedBytes: v * 8 * GB,
    memoryTotalBytes: 8 * GB,
    temperatureC: null,
    powerW: null,
  })),
  processes: [],
});

describe("resource-aware scheduling", () => {
  it("lets work start when there is room, and with no samples at all", () => {
    expect(busyMachine([sample({})], true)).toBeNull();
    expect(busyMachine([], true)).toBeNull();
  });

  it("holds a local model back when memory, CPU or every GPU is nearly full", () => {
    expect(busyMachine([sample({ mem: 0.9 })], true)).toBe("the machine is busy: memory at 90%");
    expect(busyMachine([sample({ cpu: 97 })], true)).toBe("the machine is busy: CPU at 97%");
    expect(busyMachine([sample({ vram: [0.95, 0.97] })], true)).toBe(
      "the GPU is full: VRAM at 95%",
    );
    // One GPU with room is enough.
    expect(busyMachine([sample({ vram: [0.95, 0.3] })], true)).toBeNull();
  });

  it("lets a remote agent start on a busy machine, but not one out of memory", () => {
    expect(busyMachine([sample({ mem: 0.9, cpu: 99 })], false)).toBeNull();
    expect(busyMachine([sample({ mem: 0.97 })], false)).toBe(
      "the machine is out of memory (97% used)",
    );
  });

  it("averages recent samples, so one spike doesn't hold work back", () => {
    expect(
      busyMachine([sample({ cpu: 100 }), sample({ cpu: 20 }), sample({ cpu: 20 })], true),
    ).toBeNull();
  });
});
