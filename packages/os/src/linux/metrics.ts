import type { MetricsSample, ProcessMetrics } from "@oraknid/contracts";
import type { Metrics, Watched } from "../metrics.ts";
import { type NvidiaReading, readNvidia } from "./nvidia.ts";
import { type ProcCounters, ProcFs, type SystemCounters } from "./procfs.ts";

export interface LinuxMetricsOptions {
  procfs?: ProcFs;
  clockTicks?: number;
  nvidia?: () => Promise<NvidiaReading>;
  now?: () => number;
}

export function createLinuxMetrics(options: LinuxMetricsOptions = {}): Metrics {
  const procfs = options.procfs ?? new ProcFs();
  const ticks = options.clockTicks ?? 100;
  const nvidia = options.nvidia ?? (() => readNvidia());
  const now = options.now ?? Date.now;

  let lastAt: number | undefined;
  let lastSystem: SystemCounters | undefined;
  const lastProcs = new Map<number, ProcCounters>();

  return {
    async sample(watched: Watched[]): Promise<MetricsSample> {
      const at = now();
      const seconds = lastAt === undefined ? 0 : Math.max(0.001, (at - lastAt) / 1000);
      const gpu = await nvidia();
      const sys = procfs.system();
      const seenPids = new Set<number>();

      const processes: ProcessMetrics[] = watched.flatMap((w) => {
        const pids = procfs.tree(w.pid);
        if (pids.length === 0) return [];
        let cpuTicks = 0;
        let rss = 0;
        let read = 0;
        let write = 0;
        let vram = 0;
        let zombies = 0;
        for (const pid of pids) {
          seenPids.add(pid);
          const c = procfs.process(pid);
          if (!c) continue;
          if (c.state === "Z") zombies++;
          const prev = lastProcs.get(pid);
          // A pid seen for the first time contributes no rate yet.
          if (prev && seconds > 0) {
            cpuTicks += Math.max(0, c.cpuTicks - prev.cpuTicks);
            read += Math.max(0, c.readBytes - prev.readBytes);
            write += Math.max(0, c.writeBytes - prev.writeBytes);
          }
          rss += c.rssBytes;
          vram += gpu.vramByPid.get(pid) ?? 0;
          lastProcs.set(pid, c);
        }
        return [
          {
            id: w.id,
            label: w.label,
            pid: w.pid,
            processes: pids.length,
            cpuPercent: seconds ? round((cpuTicks / ticks / seconds) * 100) : 0,
            rssBytes: rss,
            readBytesPerSec: seconds ? round(read / seconds) : 0,
            writeBytesPerSec: seconds ? round(write / seconds) : 0,
            vramBytes: vram,
            zombies,
          },
        ];
      });
      for (const pid of lastProcs.keys()) if (!seenPids.has(pid)) lastProcs.delete(pid);

      const rate = (cur: number, prev: number | undefined) =>
        prev === undefined || !seconds ? 0 : round(Math.max(0, cur - prev) / seconds);
      const cpuSpan = lastSystem ? sys.cpuTotal - lastSystem.cpuTotal : 0;
      const idleSpan = lastSystem ? sys.cpuIdle - lastSystem.cpuIdle : 0;

      const sample: MetricsSample = {
        at,
        system: {
          cpuPercent: cpuSpan > 0 ? round(((cpuSpan - idleSpan) / cpuSpan) * 100) : 0,
          cores: sys.cores,
          memoryUsedBytes: sys.memTotalBytes - sys.memAvailableBytes,
          memoryTotalBytes: sys.memTotalBytes,
          diskReadBytesPerSec: rate(sys.diskReadBytes, lastSystem?.diskReadBytes),
          diskWriteBytesPerSec: rate(sys.diskWriteBytes, lastSystem?.diskWriteBytes),
          netRxBytesPerSec: rate(sys.netRxBytes, lastSystem?.netRxBytes),
          netTxBytesPerSec: rate(sys.netTxBytes, lastSystem?.netTxBytes),
          // For the machine's safety (ADR-050).
          ...(sys.swapTotalBytes === undefined
            ? {}
            : {
                swapTotalBytes: sys.swapTotalBytes,
                swapUsedBytes: Math.max(0, sys.swapTotalBytes - (sys.swapFreeBytes ?? 0)),
                swapInBytesPerSec: rate(
                  (sys.swapInPages ?? 0) * (procfs.pageSize ?? 4096),
                  lastSystem?.swapInPages === undefined
                    ? undefined
                    : lastSystem.swapInPages * (procfs.pageSize ?? 4096),
                ),
                load1: sys.load1 ?? 0,
                pressure: sys.pressure ?? null,
                oomKills: sys.oomKills ?? null,
                thermalThrottles: sys.thermalThrottles ?? null,
              }),
        },
        gpus: gpu.gpus,
        processes,
      };
      lastAt = at;
      lastSystem = sys;
      return sample;
    },
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
