import {
  BackupDestination,
  type BackupPlanView,
  BackupRetention,
  BackupSchedule,
  BackupTarget,
} from "@oraknid/contracts";
import { describeSchedule, wrapUntrusted } from "@oraknid/core";
import { z } from "zod";
import type { ActionDef, HelperDeps } from "./service.ts";

// The helper's backup actions (ADR-044): it sets plans up, changes and
// runs them, verifies backups and makes keys. Anything that writes on a
// server (a destination there, Redis's save, SQLite's copy) asks me
// first. It never takes a password (I type those in the plan's form),
// never sees a private key, and has no way to restore: that is mine.

const PlanInput = z.object({
  name: z.string().min(1).max(80),
  target: BackupTarget,
  schedule: BackupSchedule,
  destination: BackupDestination,
  retention: BackupRetention,
  keyId: z.string().nullable(),
  enabled: z.boolean().default(true),
});
type PlanInput = z.infer<typeof PlanInput>;

/** A run of it writes on a server: there as its destination, or Redis's or SQLite's own copy. */
const writesOnServer = (p: Pick<PlanInput, "target" | "destination">) =>
  p.destination.kind === "server" || p.target.kind === "redis" || p.target.kind === "sqlite";

const need = (d: HelperDeps) => {
  if (!d.backups) throw new Error("Backups aren't available here.");
  return d.backups;
};

const link = (p: Pick<BackupPlanView, "target">) => `/servers/${p.target.serverId}/backups`;

export const BACKUP_ACTIONS: Record<string, ActionDef> = {
  list_backups: {
    kind: "read",
    description:
      "Read my backup plans (what, when, where to, retention, key, last run and its error), recent runs, and the age keys (public halves only).",
    input: z.object({ serverId: z.string().optional() }),
    confirm: () => false,
    run: async (d, i: { serverId?: string }) => {
      const b = need(d);
      const plans = await b.plans(i.serverId);
      const runs = b.runs({ limit: 20 });
      const keys = b.keys();
      return {
        result: `${plans.length} backup plan${plans.length === 1 ? "" : "s"}.`,
        link: "/settings/backups",
        data: wrapUntrusted(
          "Oraknid's records of the owner's backups",
          [
            `Plans:\n${plans.map((p) => `- ${b.describe(p)}`).join("\n") || "none"}`,
            `Recent runs:\n${
              runs
                .map(
                  (r) =>
                    `- run ${r.id} of plan ${r.planId}: ${r.state} (${r.trigger}) ${new Date(r.startedAt).toISOString().slice(0, 16)}, ${r.size ?? 0} bytes, at ${r.location}${r.error ? `, error: ${r.error}` : ""}${r.verifiedAt ? `, verified ${r.verifyOk ? "ok" : "failed"}: ${r.verifyNote}` : ""}${r.prunedAt ? ", pruned" : ""}`,
                )
                .join("\n") || "none"
            }`,
            `Keys:\n${keys.map((k) => `- ${k.name} (id ${k.id}) ${k.publicKey}${k.exportedAt ? "" : ", private key not downloaded yet"}`).join("\n") || "none"}`,
            "Restoring is the owner's alone: point them at a backup's Restore button; never offer to do it.",
          ].join("\n\n"),
        ),
      };
    },
  },
  create_backup_plan: {
    path: "backups.createPlan",
    description:
      'Create a backup plan for a database on one of my servers. target: {serverId, kind (postgres|mysql|mongodb|redis|sqlite), container (its Docker container name, or null on the host), host, port, database (null: all), user, path (SQLite file), options (optional, per kind: {postgres: {sslmode, schemas, format: plain|custom, extra}} | {mysql: {tls, singleTransaction, routines, events, triggers}} | {mongodb: {authSource, replicaSet, tls, readPreference}} | {redis: {tls}})}; schedule: {kind:"hourly",minute} | {kind:"daily",at:"03:30"} | {kind:"weekly",day:0-6 (0 Sunday),at} | {kind:"cron",line}; destination: {kind:"local",folder} | {kind:"server",serverId,folder}; retention: {count, days} (null: no limit); keyId: an age key id or null. Never ask for the password in the chat: the owner adds it in the plan\'s form.',
    input: PlanInput,
    confirm: (i: PlanInput) => writesOnServer(i),
    run: async (d, i: PlanInput) => {
      const p = await need(d).createPlan(i, "helper");
      return {
        result: `Plan "${p.name}": ${describeSchedule(p.schedule)}.${p.hasPassword ? "" : " Add the database's password in its form if it needs one."}`,
        link: link(p),
      };
    },
  },
  update_backup_plan: {
    path: "backups.updatePlan",
    description:
      "Change a backup plan: its id and the fields to change (as in create_backup_plan), or enabled false to pause it.",
    // Left out, `enabled` stays as it is: a rename doesn't switch a paused plan back on.
    input: PlanInput.partial().extend({ id: z.string(), enabled: z.boolean().optional() }),
    // What it backs up or where it goes changed: asked first, as a new plan would be.
    confirm: (i: Partial<PlanInput>) => !!(i.destination || i.target),
    run: async (d, i: Partial<PlanInput> & { id: string }) => {
      const p = await need(d).updatePlan(i as never, "helper");
      return { result: `Plan "${p.name}" changed.`, link: link(p) };
    },
  },
  run_backup: {
    description: "Run a backup plan now, by its id.",
    input: z.object({ id: z.string() }),
    // A run reads the server and may write there (a destination, Redis's save): always asked.
    confirm: () => true,
    run: async (d, i: { id: string }) => {
      const b = need(d);
      const p = await b.plan(i.id);
      b.begin(i.id, "manual", "helper");
      return { result: `"${p.name}" is running; its result comes in its runs.`, link: link(p) };
    },
  },
  verify_backup: {
    description:
      "Verify a backup (a run id from list_backups): decrypt, decompress and check it is a whole dump of its kind.",
    input: z.object({ runId: z.string() }),
    confirm: () => false,
    run: async (d, i: { runId: string }) => {
      const r = await need(d).verify(i.runId, "helper");
      return {
        result: r.verifyOk ? `Verified: ${r.verifyNote}` : `It failed its check: ${r.verifyNote}`,
        link: "/settings/backups",
      };
    },
  },
  make_backup_key: {
    description:
      "Make an age key for encrypting backups, with a name. Only its public key is shown; the owner downloads the private one from Settings → Backups → Keys.",
    input: z.object({ name: z.string().min(1).max(80) }),
    confirm: () => false,
    run: async (d, i: { name: string }) => {
      const k = await need(d).createKey(i.name, "helper");
      return {
        result: `Key "${k.name}" made: ${k.publicKey}. Download its private key once from Settings → Backups → Keys, and keep it somewhere safe.`,
        link: "/settings/backups",
      };
    },
  },
};
