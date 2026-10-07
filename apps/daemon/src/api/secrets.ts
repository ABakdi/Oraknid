import {
  Id,
  ImportDotEnv,
  ImportDotEnvResult,
  ProjectSecretsView,
  ProjectSecretView,
  SecretEnvironment,
  SetProjectSecret,
} from "@oraknid/contracts";
import { SecretStoreUnavailable } from "@oraknid/os";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { ProjectSecrets } from "../secrets/service.ts";

// A project's secrets (ADR-059, API-Contract → projectSecrets): names,
// environments and when set travel out; a value only comes in. Away from
// home, writes need a device with full rights (auth/lock.ts → HOME_ONLY).
// Named projectSecrets, not secrets: `/secrets/` is the encrypted store's
// passphrase, home only for every device.

const base = os.$context<{ projectSecrets: ProjectSecrets }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof SecretStoreUnavailable)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(
        /^No (project|secret)/.test(error.message) ? "NOT_FOUND" : "BAD_REQUEST",
        {
          message: error.message,
        },
      );
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

export const projectSecretsRouter = {
  /** Names, environments and when set: never a value. */
  list: base
    .input(z.object({ projectId: Id }))
    .output(ProjectSecretsView)
    .handler(({ context: c, input }) => guard(() => c.projectSecrets.list(input.projectId))),
  /** Sets or replaces one; its value is never returned again. */
  set: base
    .input(SetProjectSecret)
    .output(ProjectSecretView)
    .handler(({ context: c, input }) => guard(() => c.projectSecrets.set(input))),
  /** A pasted `.env`: each line set; what couldn't be read said by line. */
  importDotEnv: base
    .input(ImportDotEnv)
    .output(ImportDotEnvResult)
    .handler(({ context: c, input }) => guard(() => c.projectSecrets.importDotEnv(input))),
  remove: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.projectSecrets.remove(input.id))),
  /** The environment a new job of the project runs in. */
  setDefaultEnvironment: base
    .input(z.object({ projectId: Id, environment: SecretEnvironment }))
    .output(ProjectSecretsView)
    .handler(({ context: c, input }) =>
      guard(() => c.projectSecrets.setDefaultEnvironment(input.projectId, input.environment)),
    ),
};
