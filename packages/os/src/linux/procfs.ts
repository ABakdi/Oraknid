import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Raw counters read from /proc. Rates come from two of these. */
export interface ProcCounters {
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  rssBytes: number;
  readBytes: number;
  writeBytes: number;
}

export interface SystemCounters {
  /** All /proc/stat cpu fields except guest, and the idle + iowait part. */
  cpuTotal: number;
  cpuIdle: number;
  cores: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

export class ProcFs {
  constructor(
    readonly root = "/proc",
    readonly sysBlock = "/sys/block",
    readonly pageSize = 4096,
  ) {}

  #read(path: string): string | undefined {
    try {
      return readFileSync(join(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }

  /** The pid and every descendant, found through /proc/<pid>/task/<tid>/children. */
  tree(pid: number): number[] {
    const seen = new Set<number>();
    const stack = [pid];
    while (stack.length) {
      const p = stack.pop() as number;
      if (seen.has(p) || this.#read(`${p}/stat`) === undefined) continue;
      seen.add(p);
      let tids: string[] = [];
      try {
        tids = readdirSync(join(this.root, String(p), "task"));
      } catch {}
      for (const tid of tids) {
        const kids = this.#read(`${p}/task/${tid}/children`)?.trim();
        if (kids) for (const k of kids.split(/\s+/)) stack.push(Number(k));
      }
    }
    return [...seen];
  }

  process(pid: number): ProcCounters | undefined {
    const stat = this.#read(`${pid}/stat`);
    if (!stat) return undefined;
    // Field 2 (comm) may contain spaces and parentheses: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // rest[0] is field 3; utime is field 14, stime field 15.
    const cpuTicks = Number(rest[11]) + Number(rest[12]);
    const statm = this.#read(`${pid}/statm`)?.split(" ");
    const rssBytes = Number(statm?.[1] ?? 0) * this.pageSize;
    const io = parseKeyValues(this.#read(`${pid}/io`) ?? "");
    return {
      cpuTicks,
      rssBytes,
      readBytes: io.read_bytes ?? 0,
      writeBytes: io.write_bytes ?? 0,
    };
  }

  system(): SystemCounters {
    const statLines = (this.#read("stat") ?? "").split("\n");
    const cpu = (statLines[0] ?? "").trim().split(/\s+/).slice(1, 9).map(Number);
    const cores = statLines.filter((l) => /^cpu\d+ /.test(l)).length || 1;
    const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
    const mem = parseKeyValues(this.#read("meminfo") ?? "");

    let diskReadBytes = 0;
    let diskWriteBytes = 0;
    const disks = this.#wholeDisks();
    for (const line of (this.#read("diskstats") ?? "").split("\n")) {
      const f = line.trim().split(/\s+/);
      if (!f[2] || !disks.has(f[2])) continue;
      // Sectors are always 512 bytes in /proc/diskstats.
      diskReadBytes += Number(f[5]) * 512;
      diskWriteBytes += Number(f[9]) * 512;
    }

    let netRxBytes = 0;
    let netTxBytes = 0;
    for (const line of (this.#read("net/dev") ?? "").split("\n").slice(2)) {
      const [name, data] = line.split(":");
      if (!data || name?.trim() === "lo") continue;
      const f = data.trim().split(/\s+/).map(Number);
      netRxBytes += f[0] ?? 0;
      netTxBytes += f[8] ?? 0;
    }

    return {
      cpuTotal: cpu.reduce((a, b) => a + b, 0),
      cpuIdle: idle,
      cores,
      memTotalBytes: (mem.MemTotal ?? 0) * 1024,
      memAvailableBytes: (mem.MemAvailable ?? 0) * 1024,
      diskReadBytes,
      diskWriteBytes,
      netRxBytes,
      netTxBytes,
    };
  }

  /** Physical disks only: not partitions, loop, ram, zram or device-mapper (counted twice). */
  #wholeDisks(): Set<string> {
    try {
      return new Set(
        readdirSync(this.sysBlock).filter((d) => !/^(loop|ram|zram|dm-|sr|fd)/.test(d)),
      );
    } catch {
      return new Set();
    }
  }
}

function parseKeyValues(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([\w()]+):\s+(\d+)/);
    if (m?.[1] && m[2]) out[m[1]] = Number(m[2]);
  }
  return out;
}
