import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GpuMetrics } from "@oraknid/contracts";

const run = promisify(execFile);
const MIB = 1024 * 1024;

export function parseGpuCsv(csv: string): GpuMetrics[] {
  return csv
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, util, used, total, temp, power] = line.split(",").map((s) => s.trim());
      return {
        index: Number(index),
        name: name ?? "",
        utilizationPercent: num(util) ?? 0,
        memoryUsedBytes: Math.round((num(used) ?? 0) * MIB),
        memoryTotalBytes: Math.round((num(total) ?? 0) * MIB),
        temperatureC: num(temp),
        powerW: num(power),
      };
    });
}

/** pid → VRAM bytes. */
export function parseComputeAppsCsv(csv: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of csv.trim().split("\n").filter(Boolean)) {
    const [pid, used] = line.split(",").map((s) => s.trim());
    const bytes = (num(used) ?? 0) * MIB;
    out.set(Number(pid), (out.get(Number(pid)) ?? 0) + Math.round(bytes));
  }
  return out;
}

/** "[N/A]" and similar become null. */
function num(s: string | undefined): number | null {
  const n = Number(s);
  return s === undefined || s === "" || Number.isNaN(n) ? null : n;
}

export interface NvidiaReading {
  gpus: GpuMetrics[];
  vramByPid: Map<number, number>;
}

/** Reads GPUs through nvidia-smi; absent or failing nvidia-smi yields no GPUs. */
export async function readNvidia(command = "nvidia-smi"): Promise<NvidiaReading> {
  try {
    const [gpu, apps] = await Promise.all([
      run(
        command,
        [
          "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
          "--format=csv,noheader,nounits",
        ],
        { timeout: 3000 },
      ),
      run(command, ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], {
        timeout: 3000,
      }),
    ]);
    return { gpus: parseGpuCsv(gpu.stdout), vramByPid: parseComputeAppsCsv(apps.stdout) };
  } catch {
    return { gpus: [], vramByPid: new Map() };
  }
}
