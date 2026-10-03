import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  LegKind,
  LegPlanUsage,
  PlanHistory,
  PlanWindowView,
  QuotaWindow,
} from "@oraknid/contracts";
import type { LegAdapter } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { and, asc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { events } from "../db/schema.ts";
import { sandboxPlan } from "./plan.ts";
import type { LegRegistry, LegRow } from "./registry.ts";
import type { LegSupervisor } from "./supervisor.ts";

/** The backend's own reading costs no tokens: at most every five minutes per Leg. */
export const READ_EVERY_MS = 5 * 60_000;
/** A health prompt costs a few tokens: at most every fifteen minutes per Leg (ADR-039). */
export const PROMPT_EVERY_MS = 15 * 60_000;

/** How long each window lasts, for counting Oraknid's tokens inside it. */
export const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86400_000,
};
const span = (name: string) =>
  WINDOW_MS[name] ?? (name.startsWith("seven_day") ? 7 * 86400_000 : null);

const ACCOUNT_WINDOWS = new Set(["five_hour", "seven_day", "seven_day_oauth_apps", "overage"]);
/** A window that belongs to one model: "seven_day_opus" is Opus's. */
export const modelKey = (name: string) =>
  ACCOUNT_WINDOWS.has(name) || !name.startsWith("seven_day_")
    ? null
    : name.slice("seven_day_".length).replace(/_/g, " ");

/** A window in words. */
export function windowLabel(name: string, given?: string | null): string {
  if (given) return `Week, ${given}`;
  if (name === "five_hour") return "5 hours";
  if (name === "seven_day") return "Week";
  if (name === "seven_day_oauth_apps") return "Week, apps";
  const key = modelKey(name);
  if (key) return `Week, ${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  return name.replace(/_/g, " ");
}

/** Fullest first; a window with no figure last. */
export const byFullest = (a: { utilization: number | null }, b: { utilization: number | null }) =>
  (b.utilization ?? -1) - (a.utilization ?? -1);

/** What a Leg of another kind has instead of plan windows, in words. */
function noteFor(leg: LegRow, remote: boolean, windows: number): string | null {
  if (windows) return null;
  const config = leg.config as Record<string, unknown>;
  switch (leg.kind as LegKind) {
    case "claude-code":
      return "Not read yet: it shows after the first reading or session.";
    case "opencode":
      return config.providerID
        ? "Its provider reports no usage windows."
        : "OpenCode's free models: no usage window.";
    case "antigravity":
      return "No windows: its quota errors show here when they happen.";
    case "openai-compatible":
      return remote ? "Its server reports no usage windows." : "A local model: no limits.";
  }
  return null;
}

export interface PlanUsageOptions {
  db: Db;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  adapters: Partial<Record<LegKind, LegAdapter>>;
  sandbox: Sandbox;
  legsDir: string;
  dataDir: string;
  now?: () => number;
}

/**
 * A Leg's plan usage in view (ADR-039). Fresh readings are asked for only
 * while someone looks (the Overview or the Leg's details call `refresh`),
 * and never more often than READ_EVERY_MS for the backend's own reading
 * or PROMPT_EVERY_MS for the health prompt it falls back to.
 */
export class PlanUsage {
  readonly #lastRead = new Map<string, number>();
  readonly #lastPrompt = new Map<string, number>();
  /** Legs whose backend has no usage reading: they fall back to the prompt. */
  readonly #noReading = new Set<string>();
  readonly #busy = new Map<string, Promise<void>>();

  constructor(private readonly o: PlanUsageOptions) {}

  #now() {
    return (this.o.now ?? Date.now)();
  }

  /** Every Leg's windows, fullest first, with Oraknid's tokens in each. */
  view(): LegPlanUsage[] {
    return this.o.registry
      .all()
      .filter((l) => l.enabled)
      .map((leg) => this.viewOf(leg));
  }

  viewOf(leg: LegRow): LegPlanUsage {
    const view = this.o.registry.view(leg);
    // A model's window may sit on several of its models' rows: shown once, the newest.
    const seen = new Map<string, { w: QuotaWindow; scope: "account" | "model" }>();
    const put = (w: QuotaWindow, scope: "account" | "model") => {
      const had = seen.get(w.name);
      if (!had || had.w.observedAt < w.observedAt) seen.set(w.name, { w, scope });
    };
    for (const w of view.quota) put(w, modelKey(w.name) ? "model" : "account");
    for (const m of view.models) for (const w of m.quota) put(w, "model");
    const windows: PlanWindowView[] = [...seen.values()]
      .map(({ w, scope }) => ({
        name: w.name,
        label: windowLabel(w.name, w.label),
        scope,
        utilization: w.utilization,
        resetsAt: w.resetsAt,
        estimated: w.estimated,
        observedAt: w.observedAt,
        source: w.source ?? null,
        tokens: this.#tokens(leg, w, scope),
      }))
      .sort(byFullest);
    const checked = Math.max(this.#lastRead.get(leg.id) ?? 0, this.#lastPrompt.get(leg.id) ?? 0);
    return {
      legId: leg.id,
      name: leg.name,
      kind: leg.kind as LegKind,
      health: view.health,
      windows,
      checkedAt: checked || null,
      note: noteFor(leg, view.remote, windows.length),
    };
  }

  /** Oraknid's tokens in a window, by model: since the window began, for its models. */
  #tokens(leg: LegRow, w: QuotaWindow, scope: "account" | "model") {
    const length = span(w.name);
    const now = this.#now();
    const since = length ? (w.resetsAt ?? now) - length : now - 7 * 86400_000;
    const key = scope === "model" ? modelKey(w.name) : null;
    const models = this.o.registry
      .models(leg.id)
      .filter((m) => !key || matches(m.model, m.displayName, key));
    return this.o.registry
      .tokensByModel(
        leg.id,
        models.map((m) => m.id),
        since,
      )
      .map((t) => {
        const m = models.find((x) => x.id === t.legModelId);
        return {
          legModelId: t.legModelId,
          model: m?.model ?? "?",
          displayName: m?.displayName ?? "?",
          tokens: t.tokens,
        };
      })
      .filter((t) => t.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
  }

  /**
   * Asks each Claude Code Leg for a fresh reading, when it is due. Waits
   * for the readings it started; a Leg already being read is not read twice.
   */
  async refresh(): Promise<void> {
    const due = this.o.registry
      .all()
      .filter((l) => l.enabled && !l.paused && l.kind === "claude-code");
    await Promise.all(due.map((leg) => this.#refreshOne(leg)));
  }

  #refreshOne(leg: LegRow): Promise<void> {
    const running = this.#busy.get(leg.id);
    if (running) return running;
    const p = this.#read(leg)
      .catch((error) => console.warn(`plan usage of ${leg.name}:`, error))
      .finally(() => this.#busy.delete(leg.id));
    this.#busy.set(leg.id, p);
    return p;
  }

  async #read(leg: LegRow) {
    const now = this.#now();
    const adapter = this.o.adapters[leg.kind as LegKind];
    if (!adapter) return;
    if (adapter.planUsage && !this.#noReading.has(leg.id)) {
      if (now - (this.#lastRead.get(leg.id) ?? 0) < READ_EVERY_MS) return;
      this.#lastRead.set(leg.id, now);
      const report = await adapter.planUsage(
        this.o.registry.toConfig(leg),
        sandboxPlan(leg, this.o.sandbox, this.o.legsDir),
      );
      if (report) {
        this.o.registry.applyPlanUsage(leg.id, report);
        return;
      }
      // The tooling can't say (an older binary): sessions' events and the prompt from now on.
      this.#noReading.add(leg.id);
    }
    await this.#prompt(leg);
  }

  /**
   * The fallback (ADR-039): a tiny prompt whose rate-limit events refresh
   * the windows, only when no session has reported for PROMPT_EVERY_MS and
   * the Leg is healthy and idle, so it never costs more than a few tokens
   * every fifteen minutes while I look.
   */
  async #prompt(leg: LegRow) {
    const now = this.#now();
    if (leg.health !== "healthy" || this.o.supervisor.busy(leg.id) > 0) return;
    if (now - (this.#lastPrompt.get(leg.id) ?? 0) < PROMPT_EVERY_MS) return;
    const view = this.o.registry.view(leg);
    const newest = Math.max(
      0,
      ...view.quota.map((w) => w.observedAt),
      ...view.models.flatMap((m) => m.quota.map((w) => w.observedAt)),
    );
    if (now - newest < PROMPT_EVERY_MS) return;
    const visible = view.models.filter((m) => !m.hidden);
    const model =
      visible.find((m) => /haiku/i.test(m.model)) ??
      visible.find((m) => /sonnet/i.test(m.model)) ??
      visible[0];
    if (!model) return;
    this.#lastPrompt.set(leg.id, now);
    const cwd = join(this.o.dataDir, "plan-usage", leg.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const sup = await this.o.supervisor.start({
      legId: leg.id,
      legModelId: model.id,
      effort: null,
      jobId: null,
      taskId: null,
      attemptId: "plan-usage",
      cwd,
      systemPrompt: "Answer with the single word OK.",
      prompt: "OK?",
      onPermission: async () => ({ allow: false, message: "Nothing to do here." }),
    });
    // Its rate-limit events reach the registry through the supervisor; end it after one turn.
    const end = setTimeout(() => void this.o.supervisor.close(sup), 60_000);
    try {
      for await (const e of sup.events) if (e.type === "turn.ended") break;
    } finally {
      clearTimeout(end);
      await this.o.supervisor.close(sup);
    }
  }

  /**
   * How a Leg's windows moved (ADR-039): every reading the event log
   * keeps since `since`, and when each window filled (reached 100%) and
   * reset (its reset time moved on).
   */
  history(legId: string, since: number): PlanHistory {
    const rows = this.o.db
      .select({ at: events.at, payload: events.payload })
      .from(events)
      .where(
        and(eq(events.topic, `leg:${legId}`), eq(events.type, "leg.quota"), gte(events.at, since)),
      )
      .orderBy(asc(events.seq))
      .all();
    const points: PlanHistory["points"] = [];
    const marks: PlanHistory["marks"] = [];
    const last = new Map<string, { utilization: number | null; resetsAt: number | null }>();
    for (const r of rows) {
      const p = r.payload as {
        name?: string;
        utilization?: number | null;
        resetsAt?: number | null;
        status?: string;
      } | null;
      if (!p?.name) continue;
      const point = {
        window: p.name,
        at: r.at,
        utilization: p.utilization ?? null,
        resetsAt: p.resetsAt ?? null,
      };
      points.push(point);
      const before = last.get(p.name);
      const full = (point.utilization ?? 0) >= 1 || p.status === "rejected";
      const wasFull = (before?.utilization ?? 0) >= 1;
      if (full && !wasFull) marks.push({ window: p.name, kind: "filled", at: r.at });
      if (
        before?.resetsAt &&
        point.resetsAt &&
        point.resetsAt > before.resetsAt + 60_000 &&
        (point.utilization ?? 0) < (before.utilization ?? 0)
      )
        marks.push({ window: p.name, kind: "reset", at: before.resetsAt });
      last.set(p.name, point);
    }
    return { points, marks };
  }
}

/** Does this model belong to a model's window ("opus" for "claude-opus-4-1")? */
export const matches = (model: string, displayName: string, key: string) =>
  model.toLowerCase().includes(key) || displayName.toLowerCase().includes(key);
