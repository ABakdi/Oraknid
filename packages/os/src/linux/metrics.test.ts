import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLinuxMetrics } from "./metrics.ts";
import { parseComputeAppsCsv, parseGpuCsv } from "./nvidia.ts";
import { ProcFs } from "./procfs.ts";

/** A fake /proc with one parent (10) and one child (11). */
function fakeProc(t: { parentTicks: number; childTicks: number; rx: number; cpu: number[] }) {
  const root = mkdtempSync(join(tmpdir(), "oraknid-proc-"));
  const sys = mkdtempSync(join(tmpdir(), "oraknid-sys-"));
  mkdirSync(join(sys, "nvme0n1"));
  mkdirSync(join(sys, "loop0"));
  const proc = (pid: number, ticks: number, children: string) => {
    mkdirSync(join(root, String(pid), "task", String(pid)), { recursive: true });
    // comm with spaces and a ')' to check parsing.
    const fields = ["S", "1", ...Array(9).fill("0"), String(ticks), "0"];
    writeFileSync(join(root, String(pid), "stat"), `${pid} (my (odd) cmd) ${fields.join(" ")}\n`);
    writeFileSync(join(root, String(pid), "statm"), "100 25 0 0 0 0 0\n");
    writeFileSync(join(root, String(pid), "io"), "read_bytes: 1000\nwrite_bytes: 2000\n");
    writeFileSync(join(root, String(pid), "task", String(pid), "children"), children);
  };
  proc(10, t.parentTicks, "11 ");
  proc(11, t.childTicks, "");
  writeFileSync(join(root, "stat"), `cpu  ${t.cpu.join(" ")}\ncpu0 1\ncpu1 1\n`);
  writeFileSync(join(root, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 400 kB\n");
  writeFileSync(
    join(root, "diskstats"),
    "259 0 nvme0n1 1 0 10 0 1 0 20 0\n7 0 loop0 1 0 999 0 1 0 999 0\n",
  );
  mkdirSync(join(root, "net"));
  writeFileSync(
    join(root, "net", "dev"),
    `h1\nh2\n    lo: 999 0 0 0 0 0 0 0 999 0\n  eth0: ${t.rx} 0 0 0 0 0 0 0 50 0\n`,
  );
  return { root, sys };
}

describe("procfs", () => {
  it("reads a process tree and its counters, even with an odd command name", () => {
    const f = fakeProc({ parentTicks: 7, childTicks: 3, rx: 0, cpu: [1, 0, 0, 1, 0, 0, 0, 0] });
    const p = new ProcFs(f.root, f.sys);
    expect(p.tree(10).sort()).toEqual([10, 11]);
    expect(p.process(10)).toEqual({
      state: "S",
      cpuTicks: 7,
      rssBytes: 25 * 4096,
      readBytes: 1000,
      writeBytes: 2000,
    });
    expect(p.tree(99)).toEqual([]);
  });

  it("counts only physical disks and skips loopback network", () => {
    const f = fakeProc({ parentTicks: 0, childTicks: 0, rx: 500, cpu: [1, 0, 0, 1, 0, 0, 0, 0] });
    const s = new ProcFs(f.root, f.sys).system();
    expect(s.diskReadBytes).toBe(10 * 512);
    expect(s.netRxBytes).toBe(500);
    expect(s.netTxBytes).toBe(50);
    expect(s.cores).toBe(2);
    expect(s.memTotalBytes - s.memAvailableBytes).toBe(600 * 1024);
  });

  it("reads swap, the OOM killer's count, load, pressure and throttling (ADR-050)", () => {
    const f = fakeProc({ parentTicks: 0, childTicks: 0, rx: 0, cpu: [1, 0, 0, 1, 0, 0, 0, 0] });
    writeFileSync(
      join(f.root, "meminfo"),
      "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n",
    );
    writeFileSync(join(f.root, "vmstat"), "pswpin 12\npswpout 3\noom_kill 2\n");
    writeFileSync(join(f.root, "loadavg"), "3.50 2.00 1.00 2/300 999\n");
    mkdirSync(join(f.root, "pressure"));
    writeFileSync(
      join(f.root, "pressure", "memory"),
      "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=4.25 avg60=1.00 avg300=0.00 total=1\n",
    );
    writeFileSync(join(f.root, "pressure", "cpu"), "some avg10=30.00 avg60=0 avg300=0 total=1\n");
    writeFileSync(
      join(f.root, "pressure", "io"),
      "some avg10=1.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n",
    );
    const cpu = mkdtempSync(join(tmpdir(), "oraknid-cpu-"));
    mkdirSync(join(cpu, "cpu0", "thermal_throttle"), { recursive: true });
    writeFileSync(join(cpu, "cpu0", "thermal_throttle", "package_throttle_count"), "7\n");
    const s = new ProcFs(f.root, f.sys, 4096, cpu).system();
    expect(s).toMatchObject({
      swapTotalBytes: 2048 * 1024,
      swapFreeBytes: 1024 * 1024,
      swapInPages: 12,
      oomKills: 2,
      load1: 3.5,
      pressure: { cpu: 30, memory: 12.5, memoryFull: 4.25, io: 0.5 },
      thermalThrottles: 7,
    });
    // Without PSI or a throttle count: null, never a guess.
    const bare = new ProcFs(
      fakeProc({ parentTicks: 0, childTicks: 0, rx: 0, cpu: [1] }).root,
      f.sys,
      4096,
      f.sys,
    ).system();
    expect(bare.pressure).toBeNull();
    expect(bare.thermalThrottles).toBeNull();
    expect(bare.oomKills).toBeNull();
  });
});

describe("linux metrics", () => {
  it("turns two readings into rates for the whole process tree", async () => {
    const first = fakeProc({ parentTicks: 0, childTicks: 0, rx: 0, cpu: [0, 0, 0, 0, 0, 0, 0, 0] });
    let procfs = new ProcFs(first.root, first.sys);
    let t = 0;
    const metrics = createLinuxMetrics({
      procfs: {
        tree: (p: number) => procfs.tree(p),
        process: (p: number) => procfs.process(p),
        system: () => procfs.system(),
      } as ProcFs,
      now: () => t,
      nvidia: async () => ({ gpus: [], vramByPid: new Map([[11, 512]]) }),
    });
    const watched = [{ id: "leg-1", label: "Claude", pid: 10 }];
    const a = await metrics.sample(watched);
    expect(a.processes[0]?.cpuPercent).toBe(0);

    // One second later: 50 + 25 ticks of CPU (0.75 s), 1 MB received, 75% of CPU busy.
    const second = fakeProc({
      parentTicks: 50,
      childTicks: 25,
      rx: 1_000_000,
      cpu: [75, 0, 0, 25, 0, 0, 0, 0],
    });
    procfs = new ProcFs(second.root, second.sys);
    t = 1000;
    const b = await metrics.sample(watched);
    expect(b.processes[0]).toMatchObject({
      processes: 2,
      cpuPercent: 75,
      vramBytes: 512,
      zombies: 0,
    });
    expect(b.system.netRxBytesPerSec).toBe(1_000_000);
    expect(b.system.cpuPercent).toBe(75);
  });

  it("measures a real busy child process", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "const end=Date.now()+1500; while(Date.now()<end){}",
    ]);
    const metrics = createLinuxMetrics({
      nvidia: async () => ({ gpus: [], vramByPid: new Map() }),
    });
    const watched = [{ id: "busy", label: "busy", pid: child.pid as number }];
    await metrics.sample(watched);
    await new Promise((r) => setTimeout(r, 600));
    const s = await metrics.sample(watched);
    child.kill();
    // Measured, not idle: a shared or busy machine gives a spinning child far less than a core.
    expect(s.processes[0]?.cpuPercent).toBeGreaterThan(5);
    expect(s.processes[0]?.rssBytes).toBeGreaterThan(1_000_000);
    expect(s.system.memoryTotalBytes).toBeGreaterThan(0);
  });
});

describe("nvidia-smi parsing", () => {
  it("parses GPU rows, including [N/A] fields", () => {
    expect(parseGpuCsv("0, Quadro T1000, 22, 708, 4096, 57, [N/A]\n")).toEqual([
      {
        index: 0,
        name: "Quadro T1000",
        utilizationPercent: 22,
        memoryUsedBytes: 708 * 1024 * 1024,
        memoryTotalBytes: 4096 * 1024 * 1024,
        temperatureC: 57,
        powerW: null,
      },
    ]);
  });

  it("sums VRAM per pid across GPUs", () => {
    const m = parseComputeAppsCsv("32604, 73\n32604, 27\n711692, 41\n");
    expect(m.get(32604)).toBe(100 * 1024 * 1024);
    expect(m.get(711692)).toBe(41 * 1024 * 1024);
  });
});
