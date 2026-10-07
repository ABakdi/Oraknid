import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type LegHealth,
  type LegKind,
  type LegView,
  type NewLeg,
  type ProfileOverrides,
  type QuotaWindow,
  StoredProfile,
} from "@oraknid/contracts";
import {
  effectiveProfile,
  emptyStoredProfile,
  estimateUtilization,
  type ProviderFailure,
  restFor,
} from "@oraknid/core";
import type { LegConfig, ModelOffer, PlanUsageReport, QuotaReport } from "@oraknid/leg-sdk";
import { and, eq, gte, inArray, sum } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { legModels, legs, sessions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { matches, modelKey } from "./plan-usage.ts";

export type LegRow = typeof legs.$inferSelect;
export type LegModelRow = typeof legModels.$inferSelect;

/** How long each window Oraknid knows of lasts, for counting tokens inside it. */
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86400_000,
  seven_day_opus: 7 * 86400_000,
  seven_day_sonnet: 7 * 86400_000,
};

const secretName = (legId: string) => `leg.${legId}`;

/** The pool of Legs (Legs-and-Capability-Profiles): config, models, health, quota and profiles. */
export class LegRegistry {
  /** VRAM per loaded model, from the last health check (memory only). */
  readonly vram = new Map<string, number>();
  /**
   * Provider failures (M13.22), memory only: what rests until when, by model
   * id or `leg:<id>`, and how many in a row, so the next one rests longer.
   */
  readonly #rest = new Map<string, { until: number; reason: string; count: number }>();
  /** Provider failures in a row on each Leg, none since one of its turns went through. */
  readonly #streak = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly secrets: Secrets,
    private readonly legsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: NewLeg): Promise<LegRow> {
    const id = newId(this.now());
    const config: Record<string, unknown> = { ...input.config };
    if (input.kind === "claude-code" && !config.configDir) {
      config.configDir = join(this.legsDir, id, "claude-config");
    }
    if (typeof config.configDir === "string" && sharesMyClaude(config.configDir))
      throw new Error(
        "A Leg can't use your own ~/.claude: the sandbox would let it change what your Claude Code trusts. Leave the folder empty and log the Leg in once with the command its card shows.",
      );
    if (typeof config.configDir === "string")
      mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
    let secretRef: string | null = null;
    if (
      (input.kind === "openai-compatible" ||
        input.kind === "opencode" ||
        input.kind === "oraknid-agent") &&
      input.secret
    ) {
      secretRef = secretName(id);
      await this.secrets.set(secretRef, input.secret);
    }
    this.bus.atomically(() => {
      this.db
        .insert(legs)
        .values({
          id,
          name: input.name,
          kind: input.kind,
          config,
          secretRef,
          enabled: true,
          health: "unavailable",
          healthDetail: "Not checked yet.",
          quota: [],
          createdAt: this.now(),
        })
        .run();
      this.#event(id, "leg.created", { name: input.name, kind: input.kind });
    });
    return this.require(id);
  }

  get(id: string) {
    return this.db.select().from(legs).where(eq(legs.id, id)).get();
  }

  require(id: string): LegRow {
    const leg = this.get(id);
    if (!leg) throw new Error(`No Leg ${id}.`);
    return leg;
  }

  all(): LegRow[] {
    return this.db.select().from(legs).orderBy(legs.createdAt).all();
  }

  models(legId: string): LegModelRow[] {
    return this.db
      .select()
      .from(legModels)
      .where(eq(legModels.legId, legId))
      .orderBy(legModels.id)
      .all();
  }

  model(id: string) {
    return this.db.select().from(legModels).where(eq(legModels.id, id)).get();
  }

  toConfig(leg: LegRow): LegConfig {
    return { id: leg.id, name: leg.name, kind: leg.kind as LegKind, config: leg.config };
  }

  async credential(leg: LegRow): Promise<string | null> {
    return leg.secretRef ? ((await this.secrets.get(leg.secretRef)) ?? null) : null;
  }

  /**
   * A Leg whose config folder is my own ~/.claude gets a folder of its own
   * (Audit 1 → S1-02). It then needs one login; its card says how.
   * Returns the Legs moved.
   */
  ownConfigFolders(): string[] {
    const moved: string[] = [];
    for (const leg of this.all()) {
      const config = leg.config as Record<string, unknown>;
      if (leg.kind !== "claude-code" || typeof config.configDir !== "string") continue;
      if (!sharesMyClaude(config.configDir)) continue;
      const dir = join(this.legsDir, leg.id, "claude-config");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.bus.atomically(() => {
        this.db
          .update(legs)
          .set({
            config: { ...config, configDir: dir },
            health: "unavailable",
            healthDetail:
              "Moved to a config folder of its own; log it in once with Log in on its card.",
          })
          .where(eq(legs.id, leg.id))
          .run();
        this.#event(leg.id, "leg.updated", {
          configDir: dir,
          reason: "own config folder (Audit 1 → S1-02)",
        });
      });
      moved.push(leg.id);
    }
    return moved;
  }

  /** Changes some of a Leg's settings (never a secret). */
  setConfig(id: string, patch: Record<string, unknown>) {
    const leg = this.require(id);
    this.bus.atomically(() => {
      this.db
        .update(legs)
        .set({ config: { ...(leg.config as Record<string, unknown>), ...patch } })
        .where(eq(legs.id, id))
        .run();
      this.#event(id, "leg.updated", patch);
    });
  }

  update(id: string, patch: { name?: string; enabled?: boolean; paused?: boolean }) {
    this.require(id);
    this.bus.atomically(() => {
      this.db.update(legs).set(patch).where(eq(legs.id, id)).run();
      this.#event(id, "leg.updated", patch);
    });
  }

  async remove(id: string) {
    const leg = this.require(id);
    if (leg.secretRef) await this.secrets.delete(leg.secretRef);
    this.bus.atomically(() => {
      this.db.delete(legModels).where(eq(legModels.legId, id)).run();
      this.db.delete(legs).where(eq(legs.id, id)).run();
      this.#event(id, "leg.removed", null);
    });
  }

  /** Adds models a probe found and keeps the ones I hid or tuned; models that vanished are kept, hidden. */
  syncModels(legId: string, offers: ModelOffer[]) {
    const existing = new Map(this.models(legId).map((m) => [m.model, m]));
    this.bus.atomically(() => {
      for (const offer of offers) {
        const row = existing.get(offer.model);
        if (row) {
          const stored = this.storedProfile(row);
          const probed =
            offer.toolCalls && stored.probed?.toolCalls !== offer.toolCalls
              ? { ...stored, probed: { toolCalls: offer.toolCalls } }
              : null;
          this.db
            .update(legModels)
            .set({
              displayName: offer.displayName,
              effortLevels: offer.effortLevels,
              ...(probed ? { profile: probed } : {}),
            })
            .where(eq(legModels.id, row.id))
            .run();
          existing.delete(offer.model);
          continue;
        }
        const stored = emptyStoredProfile();
        if (offer.contextWindow) stored.overrides.contextWindow = offer.contextWindow;
        // How it calls tools, as the probe found (ADR-052 §6): none keeps it to text work.
        if (offer.toolCalls) stored.probed = { toolCalls: offer.toolCalls };
        this.db
          .insert(legModels)
          .values({
            id: newId(this.now()),
            legId,
            model: offer.model,
            displayName: offer.displayName,
            hidden: false,
            effortLevels: offer.effortLevels,
            quota: [],
            profile: stored,
          })
          .run();
      }
      for (const gone of existing.values()) {
        this.db.update(legModels).set({ hidden: true }).where(eq(legModels.id, gone.id)).run();
      }
    });
  }

  setModelHidden(modelId: string, hidden: boolean) {
    this.db.update(legModels).set({ hidden }).where(eq(legModels.id, modelId)).run();
  }

  storedProfile(row: LegModelRow): StoredProfile {
    const parsed = StoredProfile.safeParse(row.profile);
    return parsed.success ? parsed.data : emptyStoredProfile();
  }

  setOverrides(modelId: string, overrides: ProfileOverrides) {
    const row = this.model(modelId);
    if (!row) throw new Error(`No Leg model ${modelId}.`);
    const stored = { ...this.storedProfile(row), overrides };
    this.db.update(legModels).set({ profile: stored }).where(eq(legModels.id, modelId)).run();
    this.#event(row.legId, "leg.profile", { modelId });
  }

  saveProfile(modelId: string, stored: StoredProfile) {
    this.db.update(legModels).set({ profile: stored }).where(eq(legModels.id, modelId)).run();
  }

  /**
   * A session ended on its provider's error, not on its task (M13.22): its
   * model, or the whole Leg for an account's or program's error, rests
   * (doubled each time in a row), and the Leg's failures in a row are counted.
   */
  providerFailed(
    legId: string,
    legModelId: string,
    f: ProviderFailure,
  ): { until: number; inARow: number } {
    const key = f.scope === "leg" ? `leg:${legId}` : legModelId;
    const count = (this.#rest.get(key)?.count ?? 0) + 1;
    const until = this.now() + restFor(f, count);
    this.#rest.set(key, { until, reason: f.reason, count });
    const inARow = (this.#streak.get(legId) ?? 0) + 1;
    this.#streak.set(legId, inARow);
    this.#event(legId, "leg.cooldown", {
      legModelId: f.scope === "leg" ? null : legModelId,
      scope: f.scope,
      until,
      reason: f.reason,
      inARow,
    });
    return { until, inARow };
  }

  /** One of its turns went through: the provider works again for this Leg and model. */
  providerWorked(legId: string, legModelId: string) {
    this.#streak.delete(legId);
    this.#rest.delete(legModelId);
    this.#rest.delete(`leg:${legId}`);
  }

  /** The rest a model is in now, its Leg's or its own, whichever ends later. */
  cooldownOf(legId: string, legModelId: string): { until: number; reason: string } | null {
    const at = this.now();
    const live = [this.#rest.get(`leg:${legId}`), this.#rest.get(legModelId)].filter(
      (r): r is { until: number; reason: string; count: number } => !!r && r.until > at,
    );
    const last = live.sort((a, b) => b.until - a.until)[0];
    return last ? { until: last.until, reason: last.reason } : null;
  }

  /** Provider failures in a row on a Leg. */
  providerStreak(legId: string): number {
    return this.#streak.get(legId) ?? 0;
  }

  setHealth(
    id: string,
    health: LegHealth,
    detail: string | null,
    limitedUntil: number | null = null,
  ) {
    const leg = this.require(id);
    if (leg.health === health && leg.healthDetail === detail && leg.limitedUntil === limitedUntil)
      return;
    this.bus.atomically(() => {
      this.db
        .update(legs)
        .set({ health, healthDetail: detail, limitedUntil })
        .where(eq(legs.id, id))
        .run();
      this.#event(id, "leg.health", { from: leg.health, to: health, detail, limitedUntil });
    });
  }

  /**
   * Records a quota report from a session. A rejected account window makes
   * the whole Leg rate-limited until it resets; a model window only that
   * model. Missing utilization is estimated from my window limits.
   */
  applyQuota(legId: string, legModelId: string, q: QuotaReport) {
    const at = this.now();
    let utilization = q.utilization;
    let estimated = false;
    if (utilization === null) {
      const row = this.model(legModelId);
      const leg = this.require(legId);
      const limit = row
        ? effectiveProfile(leg.kind as LegKind, row.model, this.storedProfile(row)).windowLimits[
            q.window
          ]
        : undefined;
      const span = WINDOW_MS[q.window];
      if (limit && span) {
        const since = (q.resetsAt ?? at) - span;
        utilization = estimateUtilization(
          this.#tokensSince(legId, q.scope === "model" ? legModelId : null, since),
          limit,
        );
        estimated = utilization !== null;
      }
    }
    const window: QuotaWindow = {
      name: q.window,
      utilization,
      resetsAt: q.resetsAt,
      estimated,
      observedAt: at,
      source: "session",
    };
    const upsert = (list: QuotaWindow[]) => [...list.filter((w) => w.name !== q.window), window];
    this.bus.atomically(() => {
      if (q.scope === "model") {
        const row = this.model(legModelId);
        if (row) {
          this.db
            .update(legModels)
            .set({ quota: upsert(row.quota as QuotaWindow[]) })
            .where(eq(legModels.id, row.id))
            .run();
        }
      } else {
        const leg = this.require(legId);
        this.db
          .update(legs)
          .set({ quota: upsert(leg.quota as QuotaWindow[]) })
          .where(eq(legs.id, legId))
          .run();
      }
      this.#event(legId, "leg.quota", { legModelId, ...window, status: q.status, scope: q.scope });
    });
    if (q.status === "rejected" && q.scope === "account") {
      const until = q.resetsAt ?? at + 15 * 60_000;
      this.setHealth(
        legId,
        "rate-limited",
        `Usage limit reached (${q.window}); resets ${new Date(until).toISOString()}.`,
        until,
      );
    }
  }

  /**
   * Records a plan's windows as the backend's own reading gave them
   * (ADR-039). A model's window goes to that model's rows ("opus" to every
   * Opus model), or to the Leg when none of its models is that one. A
   * window whose figure didn't change only gets its new time; one that did
   * is an event, so its history is kept.
   */
  applyPlanUsage(legId: string, report: PlanUsageReport) {
    const at = this.now();
    const models = this.models(legId);
    let legQuota = [...(this.require(legId).quota as QuotaWindow[])];
    const modelQuota = new Map(models.map((m) => [m.id, [...(m.quota as QuotaWindow[])]]));
    const changed: { window: QuotaWindow; legModelId: string | null; scope: string }[] = [];
    const put = (list: QuotaWindow[], w: QuotaWindow) => {
      const old = list.find((x) => x.name === w.name);
      return {
        list: [...list.filter((x) => x.name !== w.name), w],
        moved: !old || old.utilization !== w.utilization || old.resetsAt !== w.resetsAt,
      };
    };
    for (const r of report.windows) {
      const window: QuotaWindow = {
        name: r.window,
        utilization: r.utilization,
        resetsAt: r.resetsAt,
        estimated: false,
        observedAt: at,
        source: "usage",
        ...(r.label ? { label: r.label } : {}),
      };
      const key = r.scope === "model" ? modelKey(r.window) : null;
      const owners = key ? models.filter((m) => matches(m.model, m.displayName, key)) : [];
      if (owners.length === 0) {
        const next = put(legQuota, window);
        legQuota = next.list;
        if (next.moved) changed.push({ window, legModelId: null, scope: r.scope });
        continue;
      }
      let moved = false;
      for (const m of owners) {
        const next = put(modelQuota.get(m.id) ?? [], window);
        modelQuota.set(m.id, next.list);
        moved ||= next.moved;
      }
      if (moved) changed.push({ window, legModelId: owners[0]?.id ?? null, scope: r.scope });
    }
    this.bus.atomically(() => {
      this.db.update(legs).set({ quota: legQuota }).where(eq(legs.id, legId)).run();
      for (const [id, quota] of modelQuota)
        this.db.update(legModels).set({ quota }).where(eq(legModels.id, id)).run();
      for (const c of changed)
        this.#event(legId, "leg.quota", {
          legModelId: c.legModelId,
          ...c.window,
          status: (c.window.utilization ?? 0) >= 1 ? "rejected" : "allowed",
          scope: c.scope,
        });
    });
  }

  /** Oraknid's tokens (in and out) on a Leg since a time, per model of `legModelIds`. */
  tokensByModel(legId: string, legModelIds: string[], since: number) {
    if (legModelIds.length === 0) return [];
    return this.db
      .select({
        legModelId: sessions.legModelId,
        i: sum(sessions.inputTokens),
        o: sum(sessions.outputTokens),
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.legId, legId),
          inArray(sessions.legModelId, legModelIds),
          gte(sessions.startedAt, since),
        ),
      )
      .groupBy(sessions.legModelId)
      .all()
      .map((r) => ({ legModelId: r.legModelId, tokens: Number(r.i ?? 0) + Number(r.o ?? 0) }));
  }

  #tokensSince(legId: string, legModelId: string | null, since: number): number {
    const where = legModelId
      ? and(
          eq(sessions.legId, legId),
          eq(sessions.legModelId, legModelId),
          gte(sessions.startedAt, since),
        )
      : and(eq(sessions.legId, legId), gte(sessions.startedAt, since));
    const row = this.db
      .select({ i: sum(sessions.inputTokens), o: sum(sessions.outputTokens) })
      .from(sessions)
      .where(where)
      .get();
    return Number(row?.i ?? 0) + Number(row?.o ?? 0);
  }

  view(leg: LegRow): LegView {
    const kind = leg.kind as LegKind;
    const config = leg.config as Record<string, unknown>;
    return {
      id: leg.id,
      name: leg.name,
      kind,
      config,
      hasSecret: leg.secretRef !== null,
      enabled: leg.enabled,
      paused: leg.paused,
      health: leg.health as LegHealth,
      healthDetail: leg.healthDetail,
      limitedUntil: leg.limitedUntil,
      remote: isRemote(kind, config),
      quota: leg.quota as QuotaWindow[],
      models: this.models(leg.id).map((m) => ({
        id: m.id,
        model: m.model,
        displayName: m.displayName,
        hidden: m.hidden,
        effortLevels: m.effortLevels,
        quota: m.quota as QuotaWindow[],
        profile: effectiveProfile(kind, m.model, this.storedProfile(m)),
        vramBytes: this.vram.get(`${leg.id}:${m.model}`) ?? null,
      })),
      setupHint:
        kind === "claude-code" && leg.health === "unavailable"
          ? "Log this account in: press Log in on its card and sign in on Claude's own page. Oraknid never sees the password."
          : null,
    };
  }

  #event(legId: string, type: string, payload: unknown) {
    this.bus.publish({
      type,
      topic: "overview",
      jobId: null,
      payload: { legId, ...((payload as object) ?? {}) },
    });
    this.bus.publish({ type, topic: `leg:${legId}`, jobId: null, payload });
  }
}

const LOCAL_URL = /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/;

/** Where a Leg's work is read: on this computer only for a local model server. */
function isRemote(kind: LegKind, config: Record<string, unknown>): boolean {
  if (kind === "oraknid-agent") {
    const urls = [
      ...(typeof config.baseUrl === "string" ? [config.baseUrl] : []),
      ...(Array.isArray(config.endpoints)
        ? config.endpoints.map((e) => String((e as { baseUrl?: unknown }).baseUrl))
        : []),
    ];
    return config.local !== true && (urls.length === 0 || urls.some((u) => !LOCAL_URL.test(u)));
  }
  if (kind !== "openai-compatible" && kind !== "opencode") return true;
  return !LOCAL_URL.test(String(config.baseUrl ?? config.baseURL));
}

/** Is this folder my own Claude Code's config, or inside or above it? */
export function sharesMyClaude(dir: string, home = homedir()): boolean {
  const mine = resolve(home, ".claude");
  const d = resolve(dir.replace(/^~(?=$|\/)/, home));
  return d === mine || d.startsWith(`${mine}/`) || mine.startsWith(`${d}/`);
}
