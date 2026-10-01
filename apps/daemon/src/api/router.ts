import { DoctorCheck, SystemStatus } from "@oraknid/contracts";
import { os } from "@orpc/server";
import { z } from "zod";
import { runDoctor } from "../doctor.ts";
import type { EventBus } from "../events/bus.ts";
import type { Paths } from "../paths.ts";
import { VERSION } from "../version.ts";

export interface ApiContext {
  startedAt: number;
  paths: Paths;
  bus: EventBus;
  now: () => number;
}

const base = os.$context<ApiContext>();

// Procedures follow docs/02-Architecture/API-Contract.md. Later milestones add the rest.
export const router = {
  system: {
    status: base.output(SystemStatus).handler(({ context }) => ({
      version: VERSION,
      startedAt: context.startedAt,
      uptimeMs: Math.max(0, context.now() - context.startedAt),
      pid: process.pid,
      dataDir: context.paths.dataDir,
      lastSeq: context.bus.lastSeq(),
    })),
    doctor: base.output(z.array(DoctorCheck)).handler(({ context }) => runDoctor(context.paths)),
  },
};

export type Router = typeof router;
