import {
  type MetricsSample,
  type ResourceThresholds,
  DEFAULT_THRESHOLDS_RESOURCES as TH,
} from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import {
  type AdmissionInput,
  admit,
  admitModel,
  assess,
  autoTasksAtOnce,
  defaultLegSessions,
  type Finding,
  type Incident,
  learnCost,
  type MachineReading,
  pickToPause,
  readingOf,
  runaway,
  stepGuard,
  type TreePoint,
  taskCost,
} from "./admission.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A 16 GB, 8-core machine; `free` is the share of memory available. */
const reading = (o: Partial<MachineReading> & { free?: number } = {}): MachineReading => ({
  cores: 8,
  cpu: 0.2,
  memoryTotal: 16 * GB,
  memoryAvailable: (o.free ?? 0.6) * 16 * GB,
  swapTotal: 8 * GB,
  swapUsed: 0,
  swapInPerSec: 0,
  load1: 1,
  pressure: { cpu: 0, memory: 0, memoryFull: 0, io: 0 },
  disks: [{ label: "the data folder", freeBytes: 100 * GB, totalBytes: 500 * GB }],
  oomKills: 0,
  thermalThrottles: null,
  ownRss: 1 * GB,
  ownCpu: 0.05,
  ...o,
});

const light = taskCost({ kind: "implement", verify: ["pnpm test"], instructions: "Add a page." });
const heavy = taskCost({
  kind: "implement",
  verify: ["pnpm install && pnpm build"],
  instructions: "Set up the app.",
});

const input = (o: Partial<AdmissionInput> = {}): AdmissionInput => ({
  title: "Write the login page",
  cost: light,
  running: [],
  reading: reading(),
  danger: null,
  legs: [{ name: "Claude", running: 0, limit: 3 }],
  pending: 0,
  cap: 6,
  capIsMine: false,
  thresholds: TH,
  pauseForMyWork: false,
  ...o,
});

describe("the GPU (ADR-016, ADR-054)", () => {
  const gpu = (used: number) => [{ name: "RTX", usedBytes: used * GB, totalBytes: 12 * GB }];

  it("holds a task only local models can do while every GPU is 90% full", () => {
    const local = [{ name: "Local", running: 0, limit: 1, local: true }];
    expect(admit(input({ legs: local, reading: reading({ gpus: gpu(11) }) }))).toMatchObject({
      ok: false,
      why: "gpu",
      reason: "waiting for the GPU: its memory is 92% used",
    });
    expect(admit(input({ legs: local, reading: reading({ gpus: gpu(6) }) }))).toEqual({ ok: true });
    // A task a remote agent can also do doesn't wait for the GPU.
    expect(
      admit(
        input({
          legs: [...local, { name: "Claude", running: 0, limit: 3 }],
          reading: reading({ gpus: gpu(11) }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("loads a model only with its GPU under 90% after it and memory above its floor", () => {
    const m = { name: "qwen", vramBytes: 5 * GB, gpuIndex: 0, ramBytes: 1 * GB };
    expect(admitModel(m, reading({ gpus: gpu(2) }), TH, null)).toEqual({ ok: true });
    expect(admitModel(m, reading({ gpus: gpu(6) }), TH, null)).toMatchObject({
      ok: false,
      why: "gpu",
    });
    expect(
      admitModel({ ...m, ramBytes: 9 * GB }, reading({ gpus: gpu(2) }), TH, null),
    ).toMatchObject({ ok: false, why: "memory" });
    expect(admitModel(m, reading({ gpus: gpu(2) }), TH, "Memory is nearly full.")).toMatchObject({
      ok: false,
      why: "danger",
    });
  });
});

describe("what a task costs", () => {
  it("counts builds, installs and container builds as heavy, a plain test run as light", () => {
    expect(light).toMatchObject({ heavy: false, memoryBytes: 600 * MB, why: null });
    expect(heavy.heavy).toBe(true);
    expect(heavy.why).toBe("it runs `pnpm install`");
    expect(heavy.memoryBytes).toBe(600 * MB + 2 * GB);
    expect(
      taskCost({ kind: "implement", verify: ["docker build -t x ."], instructions: "" }).heavy,
    ).toBe(true);
    expect(taskCost({ kind: "implement", verify: ["cargo test"], instructions: "" }).heavy).toBe(
      true,
    );
  });

  it("learns from what tasks of its class took, once seen twice", () => {
    const once = learnCost(null, { n: 1, peakRssBytes: 3 * GB, peakCpuPercent: 350 });
    expect(taskCost({ kind: "test", verify: [], instructions: "" }, once).heavy).toBe(false);
    const twice = learnCost(once, { n: 1, peakRssBytes: 3 * GB, peakCpuPercent: 300 });
    const c = taskCost({ kind: "test", verify: [], instructions: "" }, twice);
    expect(c.heavy).toBe(true);
    expect(c.memoryBytes).toBe(3 * GB);
    expect(c.why).toMatch(/tasks like it took 3\.0 GB/);
  });
});

describe("how many at once", () => {
  it("takes three of four cores and half the memory in sessions, at most twelve", () => {
    expect(autoTasksAtOnce(8, 16 * GB)).toBe(6);
    expect(autoTasksAtOnce(2, 4 * GB)).toBe(1);
    expect(autoTasksAtOnce(4, 4 * GB)).toBe(3);
    expect(autoTasksAtOnce(2, 2 * GB)).toBe(1);
    expect(autoTasksAtOnce(64, 256 * GB)).toBe(12);
  });

  it("gives a Claude subscription several sessions, a local model one", () => {
    expect(defaultLegSessions("claude-code")).toBe(3);
    expect(defaultLegSessions("opencode")).toBe(2);
    expect(defaultLegSessions("openai-compatible")).toBe(1);
    expect(defaultLegSessions("opencode", true)).toBe(1);
  });
});

describe("admission", () => {
  it("lets a task start with room on the machine and a Leg session free", () => {
    expect(admit(input())).toEqual({ ok: true });
    expect(admit(input({ reading: null }))).toEqual({ ok: true });
  });

  it("holds every task while the machine is in danger", () => {
    expect(admit(input({ danger: "Memory is nearly full (95% used)." }))).toEqual({
      ok: false,
      why: "danger",
      reason: "waiting for the computer to recover: memory is nearly full (95% used)",
    });
  });

  it("keeps to my cap, or the machine's", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, heavy: false }));
    expect(admit(input({ running: four, cap: 4 }))).toMatchObject({
      why: "cap",
      reason: "4 tasks run at once already, the most this computer takes",
    });
    expect(admit(input({ running: four.slice(0, 2), cap: 2, capIsMine: true }))).toMatchObject({
      reason: "2 tasks run at once already, the most I allowed",
    });
    expect(admit(input({ running: four.slice(0, 3), cap: 4 }))).toEqual({ ok: true });
  });

  it("waits for a Leg session, counting tasks admitted that hold none yet", () => {
    expect(admit(input({ legs: [{ name: "Claude", running: 3, limit: 3 }] }))).toEqual({
      ok: false,
      why: "legs",
      reason: "Claude busy with 3 sessions",
    });
    expect(admit(input({ legs: [{ name: "Claude", running: 2, limit: 3 }], pending: 1 }))).toEqual(
      expect.objectContaining({ why: "legs" }),
    );
    expect(
      admit(
        input({
          legs: [
            { name: "Claude", running: 3, limit: 3 },
            { name: "OpenCode", running: 2, limit: 2 },
          ],
        }),
      ),
    ).toMatchObject({ reason: "every Leg is busy (Claude: 3 of 3, OpenCode: 2 of 2)" });
    // Another account with room: it may start (routing spreads it there).
    expect(
      admit(
        input({
          legs: [
            { name: "Claude", running: 3, limit: 3 },
            { name: "Claude (work)", running: 0, limit: 3 },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("never runs a heavy task beside another heavy one; a light one may", () => {
    const running = [{ title: "Build the API", heavy: true }];
    expect(admit(input({ cost: heavy, running }))).toEqual({
      ok: false,
      why: "heavy",
      reason: "heavy, like “Build the API”: heavy tasks run one at a time",
    });
    expect(admit(input({ cost: light, running }))).toEqual({ ok: true });
    const two: ResourceThresholds = { ...TH, heavyAtOnce: 2 };
    expect(admit(input({ cost: heavy, running, thresholds: two }))).toEqual({ ok: true });
  });

  it("keeps memory headroom after what the task may need", () => {
    const running = [{ title: "a", heavy: false }];
    // 3.2 GB free: a heavy task's 2.6 GB would leave 0.6 GB, under 15% of 16 GB.
    expect(admit(input({ cost: heavy, running, reading: reading({ free: 0.2 }) }))).toEqual({
      ok: false,
      why: "memory",
      reason: "waiting for memory: 3.2 GB free, it may need 2.6 GB",
    });
    expect(admit(input({ cost: light, running, reading: reading({ free: 0.2 }) }))).toEqual({
      ok: true,
    });
    expect(
      admit(
        input({
          running,
          reading: reading({ pressure: { cpu: 0, memory: 25, memoryFull: 1, io: 0 } }),
        }),
      ),
    ).toMatchObject({
      why: "memory",
      reason: "waiting for memory: the computer is short of it (pressure 25%)",
    });
  });

  it("holds further work on a busy CPU, but lets the first task start unless I asked otherwise", () => {
    const busy = reading({ cpu: 0.95 });
    expect(admit(input({ reading: busy }))).toEqual({ ok: true });
    expect(admit(input({ reading: busy, running: [{ title: "a", heavy: false }] }))).toEqual({
      ok: false,
      why: "cpu",
      reason: "waiting for CPU: 95% busy",
    });
    expect(admit(input({ reading: busy, pauseForMyWork: true }))).toMatchObject({ why: "cpu" });
    // The first task still waits when memory is all but gone.
    expect(admit(input({ reading: reading({ free: 0.12 }) }))).toMatchObject({ why: "memory" });
  });

  it("waits for disk space", () => {
    expect(
      admit(
        input({
          reading: reading({
            disks: [{ label: "the data folder", freeBytes: 1 * GB, totalBytes: 500 * GB }],
          }),
        }),
      ),
    ).toEqual({
      ok: false,
      why: "disk",
      reason: "waiting for disk space: 1.0 GB free on the data folder",
    });
  });
});

/** Runs readings through the guard as the daemon does, every five seconds. */
function guard(readings: MachineReading[], pauseForMyWork = false) {
  let open = new Map<string, Incident>();
  const opened: Finding[] = [];
  const closed: string[] = [];
  let prev: MachineReading | null = null;
  readings.forEach((r, i) => {
    const step = stepGuard(
      open,
      assess(r, TH, new Set(open.keys()), prev, pauseForMyWork),
      i * 5000,
    );
    open = step.open;
    opened.push(...step.opened);
    closed.push(...step.closed.map((c) => c.finding.kind));
    prev = r;
  });
  return { open, opened, closed };
}

describe("the guard", () => {
  it("sees memory near a crash, once, and lets it go only well clear of it", () => {
    const swapping = { swapInPerSec: 5 * MB };
    const g = guard([
      reading({ free: 0.5 }),
      reading({ free: 0.08, cpu: 0.97, ...swapping }),
      reading({ free: 0.09, ...swapping }),
      // Hovering just above the line: still the same incident.
      reading({ free: 0.12, ...swapping }),
      reading({ free: 0.11, ...swapping }),
      ...Array.from({ length: 8 }, () => reading({ free: 0.4 })),
    ]);
    expect(g.opened.map((f) => f.kind)).toEqual(["memory"]);
    expect(g.opened[0]?.message).toBe(
      "Memory and CPU are both nearly full (memory 92% used, CPU 97%), and the computer is swapping.",
    );
    expect(g.opened[0]?.relieve).toBe(true);
    expect(g.closed).toEqual(["memory"]);
  });

  it("doesn't call low memory danger while nothing swaps or stalls", () => {
    expect(assess(reading({ free: 0.08 }), TH, new Set())).toEqual([]);
    // Without swap, low memory is the danger itself.
    expect(assess(reading({ free: 0.08, swapTotal: 0 }), TH, new Set())[0]?.kind).toBe("memory");
  });

  it("sees thrashing, an overloaded machine, a full disk, the OOM killer and heat", () => {
    const kinds = (r: MachineReading, prev?: MachineReading) =>
      assess(r, TH, new Set(), prev).map((f) => `${f.kind}:${f.level}`);
    expect(kinds(reading({ swapInPerSec: 40 * MB }))).toEqual(["swap:danger"]);
    expect(kinds(reading({ load1: 40, free: 0.15 }))).toEqual(["load:danger"]);
    expect(
      kinds(
        reading({ disks: [{ label: "the project", freeBytes: 1 * GB, totalBytes: 100 * GB }] }),
      ),
    ).toEqual(["disk:the project:warning"]);
    expect(kinds(reading({ oomKills: 3 }), reading({ oomKills: 1 }))).toEqual(["oom:danger"]);
    expect(kinds(reading({ thermalThrottles: 9 }), reading({ thermalThrottles: 4 }))).toEqual([
      "thermal:warning",
    ]);
    expect(assess(reading({ oomKills: 3 }), TH, new Set(), reading({ oomKills: 3 }))).toEqual([]);
  });

  it("says the machine is busy with my own work only when I asked to pause for it", () => {
    const mine = reading({ cpu: 0.95, ownCpu: 0.05 });
    expect(assess(mine, TH, new Set())).toEqual([]);
    expect(assess(mine, TH, new Set(), null, true)[0]).toMatchObject({
      kind: "busy",
      level: "warning",
      relieve: true,
    });
    // Busy with Oraknid's own work is not "my own things".
    expect(assess(reading({ cpu: 0.95, ownCpu: 0.8 }), TH, new Set(), null, true)).toEqual([]);
  });
});

const points = (n: number, every: number, f: (i: number) => Partial<TreePoint>): TreePoint[] =>
  Array.from({ length: n }, (_, i) => ({
    at: i * every,
    rssBytes: 500 * MB,
    processes: 5,
    cpuPercent: 10,
    zombies: 0,
    lastOutputAt: i * every,
    ...f(i),
  }));

describe("a session running away", () => {
  it("sees memory growing without bound", () => {
    const r = runaway(points(40, 5000, (i) => ({ rssBytes: 1 * GB + i * 100 * MB })));
    expect(r?.kind).toBe("memory");
    expect(r?.message).toBe(
      "its memory grew from 1.0 GB to 4.8 GB in 3 minutes and keeps growing.",
    );
    // A build that rises and falls back is not running away.
    expect(
      runaway(points(40, 5000, (i) => ({ rssBytes: (i % 4 === 0 ? 1 : 2.5) * GB }))),
    ).toBeNull();
  });

  it("sees a fork bomb and a zombie storm", () => {
    expect(runaway(points(7, 5000, (i) => ({ processes: 5 + i * 40 })))?.kind).toBe("fork");
    expect(runaway(points(2, 5000, () => ({ processes: 500 })))?.kind).toBe("fork");
    expect(runaway(points(2, 5000, () => ({ zombies: 80 })))?.message).toBe(
      "80 defunct processes pile up in its tree, never reaped.",
    );
  });

  it("sees a CPU pegged for minutes with nothing said, not one that talks", () => {
    const silent = points(61, 5000, () => ({ cpuPercent: 99, lastOutputAt: 0 }));
    expect(runaway(silent)?.kind).toBe("cpu");
    expect(runaway(points(61, 5000, (i) => ({ cpuPercent: 99, lastOutputAt: i * 5000 })))).toBe(
      null,
    );
    expect(runaway(points(61, 5000, () => ({})))).toBeNull();
  });
});

describe("what to pause for room", () => {
  it("takes the heaviest when it clearly is, else the newest", () => {
    expect(
      pickToPause([
        { id: "a", startedAt: 1, rssBytes: 3 * GB },
        { id: "b", startedAt: 2, rssBytes: 1 * GB },
      ])?.id,
    ).toBe("a");
    expect(
      pickToPause([
        { id: "a", startedAt: 1, rssBytes: 1 * GB },
        { id: "b", startedAt: 2, rssBytes: 1.1 * GB },
      ])?.id,
    ).toBe("b");
    expect(pickToPause([])).toBeNull();
  });
});

describe("a reading from samples", () => {
  it("averages CPU and swap-in, takes memory as it is now, and sums Oraknid's processes", () => {
    const s = (cpu: number, used: number, swapIn: number): MetricsSample => ({
      at: 0,
      system: {
        cpuPercent: cpu,
        cores: 4,
        memoryUsedBytes: used * GB,
        memoryTotalBytes: 8 * GB,
        diskReadBytesPerSec: 0,
        diskWriteBytesPerSec: 0,
        netRxBytesPerSec: 0,
        netTxBytesPerSec: 0,
        swapInBytesPerSec: swapIn,
      },
      gpus: [],
      processes: [
        {
          id: "daemon",
          label: "d",
          pid: 1,
          processes: 1,
          cpuPercent: 40,
          rssBytes: 1 * GB,
          readBytesPerSec: 0,
          writeBytesPerSec: 0,
          vramBytes: 0,
        },
      ],
    });
    const r = readingOf([s(100, 4, 0), s(20, 6, 10 * MB)]);
    expect(r).toMatchObject({
      cpu: 0.6,
      memoryAvailable: 2 * GB,
      swapInPerSec: 5 * MB,
      ownRss: 1 * GB,
      ownCpu: 0.1,
      pressure: null,
    });
    expect(readingOf([])).toBeNull();
  });
});
