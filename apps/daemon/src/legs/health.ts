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

  async function check(leg: LegRow): Promise<void> {
    if (!leg.enabled) return o.registry.setHealth(leg.id, "disabled", "Disabled by me.");
    const adapter = o.adapters[leg.kind as LegKind];
    if (!adapter)
      return o.registry.setHealth(leg.id, "unavailable", `No adapter for ${leg.kind} yet.`);
    const probe = await adapter
      .probe(o.registry.toConfig(leg), sandboxPlan(leg, o.sandbox, o.legsDir))
      .catch((e: Error) => ({ ok: false as const, detail: e.message, models: [] }));
    if (!probe.ok) return o.registry.setHealth(leg.id, "unavailable", probe.detail);
    o.registry.syncModels(leg.id, probe.models);
    if (leg.kind === "openai-compatible") await readVram(leg);
    if (leg.limitedUntil && leg.limitedUntil > now()) return; // still waiting for the window to reset
    o.registry.setHealth(leg.id, "healthy", probe.detail, null);
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
    checkAll,
    stop: () => clearInterval(timer),
  };
}
