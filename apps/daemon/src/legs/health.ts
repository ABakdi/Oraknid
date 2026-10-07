import { rmSync } from "node:fs";
import { join } from "node:path";
import type { LegKind } from "@oraknid/contracts";
import type { LegAdapter } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { sandboxPlan } from "./plan.ts";
import type { LegRegistry, LegRow } from "./registry.ts";

export interface HealthOptions {
  registry: LegRegistry;
  adapters: Partial<Record<LegKind, LegAdapter>>;
  sandbox: Sandbox;
  legsDir: string;
  intervalMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Checks every Leg once a minute (Legs spec → Health) and keeps models and VRAM current. */
export function startHealthChecks(o: HealthOptions) {
  const now = o.now ?? Date.now;
  const http = o.fetch ?? fetch;
  let running = false;

  /** The adapter's probe of a Leg, saved or not. */
  async function probe(leg: LegRow) {
    const adapter = o.adapters[leg.kind as LegKind];
    if (!adapter)
      return { ok: false as const, detail: `No adapter for ${leg.kind} yet.`, models: [] };
    return adapter
      .probe(o.registry.toConfig(leg), sandboxPlan(leg, o.sandbox, o.legsDir))
      .catch((e: Error) => ({ ok: false as const, detail: e.message, models: [] }));
  }

  async function check(leg: LegRow): Promise<void> {
    if (!leg.enabled) return o.registry.setHealth(leg.id, "disabled", "Disabled by me.");
    const found = await probe(leg);
    if (!found.ok) return o.registry.setHealth(leg.id, "unavailable", found.detail);
    o.registry.syncModels(leg.id, found.models);
    if ("features" in found) o.registry.setFeatures(leg.id, found.features);
    if (leg.kind === "openai-compatible") await readVram(leg);
    if (leg.limitedUntil && leg.limitedUntil > now()) return; // still waiting for the window to reset
    o.registry.setHealth(leg.id, "healthy", found.detail, null);
  }

  /** Ollama reports what each loaded model holds in VRAM; other servers simply don't answer. */
  async function readVram(leg: LegRow) {
    const root = String((leg.config as Record<string, unknown>).baseUrl).replace(/\/v1\/?$/, "");
    try {
      const res = await http(`${root}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const body = (await res.json()) as {
        models?: { name: string; model?: string; size_vram?: number }[];
      };
      for (const key of [...o.registry.vram.keys()])
        if (key.startsWith(`${leg.id}:`)) o.registry.vram.delete(key);
      for (const m of body.models ?? [])
        o.registry.vram.set(`${leg.id}:${m.model ?? m.name}`, m.size_vram ?? 0);
    } catch {}
  }

  async function checkAll() {
    if (running) return;
    running = true;
    try {
      await Promise.all(o.registry.all().map((leg) => check(leg)));
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void checkAll(), o.intervalMs ?? 60_000);
  timer.unref();
  return {
    check: (id: string) => check(o.registry.require(id)),
    /**
     * A Leg not saved yet, tested (Legs spec → Adding a Leg): nothing is
     * written but the scratch home its probe needs, removed after.
     */
    async trial(leg: LegRow): Promise<{ ok: boolean; detail: string }> {
      try {
        const r = await probe(leg);
        return { ok: r.ok, detail: r.detail };
      } finally {
        rmSync(join(o.legsDir, leg.id), { recursive: true, force: true });
      }
    },
    checkAll,
    stop: () => clearInterval(timer),
  };
}
