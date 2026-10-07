import type { ModelFit, ModelRunSettings } from "@oraknid/contracts";
import { gb } from "@oraknid/core";

// Does a model fit this computer, and how should it run (ADR-054)? Its
// weights take about their file's size, plus room for its context; the GPU
// is kept under 90% (ADR-050), and memory keeps its floor.

const GB = 1024 ** 3;

export interface MachineRoom {
  gpus: { name: string; totalBytes: number; usedBytes: number }[];
  memoryTotal: number;
  memoryAvailable: number;
  /** Free on the models folder's disk; null when not known. */
  diskFree: number | null;
  /** The disk floor of ADR-050. */
  minFreeDisk: number;
}

/** What loading takes besides the weights: the context (KV cache) and the server's buffers. */
const overhead = (size: number, context = 8192) =>
  size * 0.05 + (context / 8192) * 0.5 * GB + 0.2 * GB;

/** The GPU with the most room below 90%, and that room. */
export function bestGpu(m: MachineRoom): { index: number; room: number } | null {
  let best: { index: number; room: number } | null = null;
  m.gpus.forEach((g, index) => {
    const room = g.totalBytes * 0.9 - g.usedBytes;
    if (!best || room > best.room) best = { index, room };
  });
  return best;
}

export function fitOf(size: number | null, m: MachineRoom): ModelFit {
  if (size === null) return { fits: "unknown", runsOn: null, note: "Its size isn't known." };
  if (m.diskFree !== null && size > m.diskFree - m.minFreeDisk)
    return {
      fits: "no",
      runsOn: null,
      note: `Not enough disk: it takes ${gb(size)}, ${gb(Math.max(0, m.diskFree))} free.`,
    };
  const need = size + overhead(size);
  const gpu = bestGpu(m);
  const ram = m.memoryAvailable * 0.8;
  if (gpu && gpu.room >= need)
    return {
      fits: "yes",
      runsOn: "gpu",
      note: `Fits the GPU: about ${gb(need)} of ${gb(m.gpus[gpu.index]?.totalBytes ?? 0)}.`,
    };
  if (gpu && gpu.room >= 1 * GB && gpu.room + ram >= need)
    return {
      fits: "tight",
      runsOn: "split",
      note: `Part on the GPU, part in memory (about ${gb(need)}): slower.`,
    };
  if (ram >= need)
    return m.gpus.length || size > 4 * GB
      ? {
          fits: "tight",
          runsOn: "cpu",
          note: `Runs on the CPU (about ${gb(need)} of memory): slow.`,
        }
      : { fits: "yes", runsOn: "cpu", note: `Runs on the CPU, about ${gb(need)} of memory.` };
  return {
    fits: "no",
    runsOn: null,
    note: `Too big for this computer: it needs about ${gb(need)}, ${gb(m.memoryAvailable)} of memory${gpu ? ` and ${gb(Math.max(0, gpu.room))} of GPU` : ""} free.`,
  };
}

export interface RunPlan {
  gpuLayers: number;
  contextSize: number;
  /** What it will hold on the GPU and in memory once loaded. */
  vramBytes: number;
  ramBytes: number;
  gpuIndex: number | null;
}

/** How to run a model here: GPU layers and context, automatic unless set. */
export function runPlan(
  size: number,
  model: { layers: number | null; contextLength: number | null },
  m: MachineRoom,
  s: Pick<ModelRunSettings, "contextSize" | "gpuLayers">,
): RunPlan {
  const gpu = bestGpu(m);
  const trained = model.contextLength ?? 32_768;
  let context: number;
  if (s.contextSize !== "auto") context = Math.min(s.contextSize, trained);
  else {
    const room = (gpu?.room ?? 0) - size - overhead(size);
    context = Math.min(trained, room >= 3 * GB ? 32_768 : room >= 1 * GB ? 16_384 : 8192);
  }
  const need = size + overhead(size, context);
  let fraction: number;
  if (s.gpuLayers !== "auto")
    fraction = model.layers ? Math.min(1, s.gpuLayers / model.layers) : s.gpuLayers > 0 ? 1 : 0;
  else if (!gpu || gpu.room < 1 * GB) fraction = 0;
  else if (gpu.room >= need) fraction = 1;
  else fraction = model.layers ? Math.max(0, (gpu.room - overhead(size, context)) / size) : 0;
  const layers =
    s.gpuLayers !== "auto"
      ? s.gpuLayers
      : fraction >= 1
        ? 999
        : model.layers
          ? Math.floor(model.layers * fraction)
          : 0;
  const onGpu = fraction >= 1 ? need : layers > 0 ? size * fraction + overhead(size, context) : 0;
  return {
    gpuLayers: layers,
    contextSize: context,
    vramBytes: Math.round(onGpu),
    ramBytes: Math.round(Math.max(0.3 * GB, need - onGpu)),
    gpuIndex: onGpu > 0 ? (gpu?.index ?? null) : null,
  };
}
