import {
  ChannelTestResult,
  DoctorCheck,
  EmailSettings,
  LegView,
  MetricsSample,
  NewLeg,
  NotificationChannel,
  NotificationSettings,
  ProfileOverrides,
  PushSubscriptionInput,
  SystemStatus,
} from "@oraknid/contracts";
import {
  type InhibitorState,
  type SandboxStatus,
  SecretStoreUnavailable,
  type ServiceManager,
} from "@oraknid/os";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { runDoctor } from "../doctor.ts";
import type { JobStore } from "../engine/jobs.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { Notifications } from "../notify/notifications.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { VERSION } from "../version.ts";

export interface ApiContext {
  startedAt: number;
  paths: Paths;
  bus: EventBus;
  now: () => number;
  inhibitor: () => InhibitorState;
  secrets: Secrets;
  sandbox: () => SandboxStatus;
  service: ServiceManager;
  notifications: Notifications;
  recentMetrics: (since: number) => MetricsSample[];
  jobs: JobStore;
  runner: JobRunner;
  registry: LegRegistry;
  health: { check(id: string): Promise<void> };
}

const base = os.$context<ApiContext>();

/** Errors carry a sentence for the UI (BR-17). */
const userError = (message: string) => new ORPCError("BAD_REQUEST", { message });

/** Turns a refusal (an illegal move, an unknown job) into a sentence for the UI. */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw userError(error instanceof Error ? error.message : String(error));
  }
}

// Procedures follow docs/02-Architecture/API-Contract.md. Later milestones add the rest.
export const router = {
  system: {
    status: base.output(SystemStatus).handler(({ context: c }) => ({
      version: VERSION,
      startedAt: c.startedAt,
      uptimeMs: Math.max(0, c.now() - c.startedAt),
      pid: process.pid,
      dataDir: c.paths.dataDir,
      lastSeq: c.bus.lastSeq(),
      inhibitor: c.inhibitor(),
      secrets: c.secrets.status(),
      sandbox: c.sandbox(),
      service: c.service.status(),
    })),
    doctor: base.output(z.array(DoctorCheck)).handler(({ context: c }) =>
      runDoctor(c.paths, {
        sandbox: c.sandbox(),
        secrets: c.secrets.status(),
        service: c.service.status(),
      }),
    ),
  },
  secrets: {
    unlock: base.input(z.object({ passphrase: z.string() })).handler(({ context: c, input }) => {
      try {
        return c.secrets.unlock(input.passphrase);
      } catch (error) {
        if (error instanceof SecretStoreUnavailable) throw userError(error.message);
        throw error;
      }
    }),
  },
  jobs: {
    // Creating jobs arrives with The Eye (M1.6) and the job form (M1.8).
    pause: base
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .handler(({ context: c, input }) =>
        guard(() => c.runner.pause(input.id, input.reason ?? "Paused by me.")),
      ),
    resume: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.runner.resume(input.id))),
    cancel: base
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .handler(({ context: c, input }) =>
        guard(() => c.runner.cancel(input.id, input.reason ?? "Cancelled by me.")),
      ),
  },
  legs: {
    list: base
      .output(z.array(LegView))
      .handler(({ context: c }) => c.registry.all().map((l) => c.registry.view(l))),
    get: base
      .input(z.object({ id: z.string() }))
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(() => c.registry.view(c.registry.require(input.id))),
      ),
    /** Adds a Leg and tests it straight away (Legs spec → Adding a Leg). */
    create: base
      .input(NewLeg)
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(async () => {
          const leg = await c.registry.create(input);
          await c.health.check(leg.id);
          return c.registry.view(c.registry.require(leg.id));
        }),
      ),
    test: base
      .input(z.object({ id: z.string() }))
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(async () => {
          await c.health.check(input.id);
          return c.registry.view(c.registry.require(input.id));
        }),
      ),
    update: base
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(async () => {
          const { id, ...patch } = input;
          c.registry.update(id, patch);
          await c.health.check(id);
        }),
      ),
    pause: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.update(input.id, { paused: true })),
      ),
    resume: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.update(input.id, { paused: false })),
      ),
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.registry.remove(input.id))),
    setModelHidden: base
      .input(z.object({ modelId: z.string(), hidden: z.boolean() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.setModelHidden(input.modelId, input.hidden)),
      ),
    setProfile: base
      .input(z.object({ modelId: z.string(), overrides: ProfileOverrides }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.setOverrides(input.modelId, input.overrides)),
      ),
  },
  metrics: {
    recent: base
      .input(z.object({ since: z.number().int().nonnegative().default(0) }))
      .output(z.array(MetricsSample))
      .handler(({ context: c, input }) => c.recentMetrics(input.since)),
  },
  notifications: {
    get: base.output(NotificationSettings).handler(({ context: c }) => c.notifications.settings()),
    update: base
      .input(z.object({ desktop: z.boolean(), push: z.boolean(), email: z.boolean() }).partial())
      .output(NotificationSettings)
      .handler(({ context: c, input }) => {
        try {
          return c.notifications.update(input);
        } catch (error) {
          throw userError((error as Error).message);
        }
      }),
    configureEmail: base
      .input(z.object({ server: EmailSettings, password: z.string().min(1).optional() }))
      .output(NotificationSettings)
      .handler(async ({ context: c, input }) => {
        try {
          return await c.notifications.configureEmail(input.server, input.password);
        } catch (error) {
          if (error instanceof SecretStoreUnavailable) throw userError(error.message);
          throw error;
        }
      }),
    test: base
      .input(z.object({ channel: NotificationChannel.optional() }))
      .output(z.array(ChannelTestResult))
      .handler(({ context: c, input }) => c.notifications.test(input.channel)),
    vapidPublicKey: base.output(z.string()).handler(async ({ context: c }) => {
      try {
        return await c.notifications.vapidPublicKey();
      } catch (error) {
        if (error instanceof SecretStoreUnavailable) throw userError(error.message);
        throw error;
      }
    }),
    subscribe: base.input(PushSubscriptionInput).handler(({ context: c, input }) => {
      c.notifications.subscribe(input);
    }),
    unsubscribe: base
      .input(z.object({ endpoint: z.string() }))
      .handler(({ context: c, input }) => c.notifications.unsubscribe(input.endpoint)),
  },
};

export type Router = typeof router;
