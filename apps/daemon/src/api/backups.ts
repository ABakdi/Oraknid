import {
  BackupKeyView,
  BackupPlanPatch,
  BackupPlanTest,
  BackupPlanView,
  BackupRunView,
  BackupTarget,
  BackupTestResult,
  Id,
  NewBackupPlan,
  RestorePreview,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { Backups } from "../backups/service.ts";
import type { Downloads } from "../cloud/routes.ts";
import { notAway } from "./cloud.ts";

// Backups (ADR-044, API-Contract → backups). Away from home, changing a
// plan or a key and restoring are for a device with full rights
// (auth/lock.ts → HOME_ONLY); a restore always takes two steps, and no
// agent has a way to it.

const base = os.$context<{ backups: Backups; downloads: Downloads; remote: boolean }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(
        /^No (backup|server)/.test(error.message)
          ? "NOT_FOUND"
          : /already|running/.test(error.message)
            ? "CONFLICT"
            : "BAD_REQUEST",
        { message: error.message },
      );
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

export const backupsRouter = {
  plans: base
    .input(z.object({ serverId: Id.optional() }).optional())
    .output(z.array(BackupPlanView))
    .handler(({ context: c, input }) => guard(() => c.backups.plans(input?.serverId))),
  createPlan: base
    .input(NewBackupPlan)
    .output(BackupPlanView)
    .handler(({ context: c, input }) => guard(() => c.backups.createPlan(input))),
  updatePlan: base
    .input(BackupPlanPatch)
    .output(BackupPlanView)
    .handler(({ context: c, input }) => guard(() => c.backups.updatePlan(input))),
  /**
   * Test connection: the plan's form as it is, nothing saved (with
   * `planId`, an empty password or connection string is the plan's kept one).
   */
  testPlan: base
    .input(BackupPlanTest)
    .output(BackupTestResult)
    .handler(({ context: c, input }) => guard(() => c.backups.testPlan(input))),
  /** Its backups stay where they are unless `deleteBackups`. */
  removePlan: base
    .input(z.object({ id: Id, deleteBackups: z.boolean().default(false) }))
    .handler(({ context: c, input }) =>
      guard(() => c.backups.removePlan(input.id, input.deleteBackups)),
    ),
  /** Run now: returns at once with the run's id; its end comes as an event. */
  run: base
    .input(z.object({ id: Id }))
    .output(z.object({ runId: Id }))
    .handler(({ context: c, input }) =>
      guard(() => {
        const { runId, done } = c.backups.begin(input.id, "manual");
        void done.catch(() => {});
        return { runId };
      }),
    ),
  runs: base
    .input(z.object({ planId: Id.optional(), limit: z.number().int().min(1).max(500).optional() }))
    .output(z.array(BackupRunView))
    .handler(({ context: c, input }) => guard(() => c.backups.runs(input))),
  verify: base
    .input(z.object({ runId: Id }))
    .output(BackupRunView)
    .handler(({ context: c, input }) => guard(() => c.backups.verify(input.runId))),
  /**
   * A link to download a kept backup (ADR-046), good once and for two
   * minutes: as stored, or `decrypt`ed with its key (still compressed).
   */
  downloadLink: base
    .input(z.object({ runId: Id, decrypt: z.boolean().default(false) }))
    .output(z.object({ url: z.string(), expiresAt: z.number() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        notAway(c.remote);
        // Refused now, in words, rather than when the link is opened.
        const run = c.backups.run(input.runId);
        if (run.state !== "ok" || run.prunedAt || !run.path)
          throw new Error("That backup isn't kept any more.");
        if (input.decrypt && !run.keyId) throw new Error("That backup isn't encrypted.");
        return c.downloads.mint(() => c.backups.openStored(input.runId, input.decrypt));
      }),
    ),
  /** A restore's first step: what it replaces, and the word to type back. */
  prepareRestore: base
    .input(
      z.object({
        runId: Id,
        /** Another database; omitted: the plan's own. */
        target: BackupTarget.optional(),
        /** Its password, used for this restore only. */
        password: z.string().min(1).max(1024).optional(),
      }),
    )
    .output(RestorePreview)
    .handler(({ context: c, input }) => guard(() => c.backups.prepareRestore(input))),
  /** The second step, with the word typed back. */
  restore: base
    .input(z.object({ token: z.string().min(1), confirm: z.string() }))
    .output(z.object({ note: z.string() }))
    .handler(({ context: c, input }) => guard(() => c.backups.restore(input.token, input.confirm))),
  keys: base
    .output(z.array(BackupKeyView))
    .handler(({ context: c }) => guard(() => c.backups.keys())),
  createKey: base
    .input(z.object({ name: z.string().min(1).max(80) }))
    .output(BackupKeyView)
    .handler(({ context: c, input }) => guard(() => c.backups.createKey(input.name))),
  importKey: base
    .input(z.object({ name: z.string().min(1).max(80), privateKey: z.string().min(1).max(200) }))
    .output(BackupKeyView)
    .handler(({ context: c, input }) =>
      guard(() => c.backups.importKey(input.name, input.privateKey)),
    ),
  /** The private key, once. */
  exportKey: base
    .input(z.object({ id: Id }))
    .output(z.object({ name: z.string(), publicKey: z.string(), privateKey: z.string() }))
    .handler(({ context: c, input }) => guard(() => c.backups.exportKey(input.id))),
  renameKey: base
    .input(z.object({ id: Id, name: z.string().min(1).max(80) }))
    .handler(({ context: c, input }) => guard(() => c.backups.renameKey(input.id, input.name))),
  removeKey: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.backups.removeKey(input.id))),
};
