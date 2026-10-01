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
import { effectiveProfile, emptyStoredProfile, estimateUtilization } from "@oraknid/core";
import type { LegConfig, ModelOffer, QuotaReport } from "@oraknid/leg-sdk";
import { and, eq, gte, sum } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { legModels, legs, sessions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";

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
    if ((input.kind === "openai-compatible" || input.kind === "opencode") && input.secret) {
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
            healthDetail: `Moved to a config folder of its own; log it in once: CLAUDE_CONFIG_DIR="${dir}" ${String(config.binary ?? "claude")} — then /login.`,
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
          this.db
            .update(legModels)
            .set({ displayName: offer.displayName, effortLevels: offer.effortLevels })
            .where(eq(legModels.id, row.id))
            .run();
          existing.delete(offer.model);
          continue;
        }
        const stored = emptyStoredProfile();
        if (offer.contextWindow) stored.overrides.contextWindow = offer.contextWindow;
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
      remote:
        (kind !== "openai-compatible" && kind !== "opencode") ||
        !/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(String(config.baseUrl ?? config.baseURL)),
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
          ? `Log this account in: CLAUDE_CONFIG_DIR="${String(config.configDir)}" ${String(config.binary ?? "claude")} — then /login. Oraknid never handles the login itself.`
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

/** Is this folder my own Claude Code's config, or inside or above it? */
export function sharesMyClaude(dir: string, home = homedir()): boolean {
  const mine = resolve(home, ".claude");
  const d = resolve(dir.replace(/^~(?=$|\/)/, home));
  return d === mine || d.startsWith(`${mine}/`) || mine.startsWith(`${d}/`);
}
