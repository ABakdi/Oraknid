import {
  CatalogEntry,
  Id,
  LocalModelView,
  ModelDownload,
  ModelRole,
  ModelSearch,
  ModelSettingsPatch,
  ModelSource,
  ModelsStatus,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { LocalModels } from "../models/service.ts";

// Local models (ADR-054, API-Contract → models): the Models page and the
// terminal app's /models. Searching reaches Hugging Face and ollama.com;
// everything else stays on this computer.

const base = os.$context<{ models: LocalModels }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(
        /^No model/.test(error.message)
          ? "NOT_FOUND"
          : /can't load now|isn't downloaded|isn't paused|isn't downloading|Not enough disk/.test(
                error.message,
              )
            ? "CONFLICT"
            : "BAD_REQUEST",
        { message: error.message },
      );
    throw error;
  }
}

export const modelsRouter = {
  /** Where models live, the disk, the runtimes found, the machine, and each role's model. */
  status: base.output(ModelsStatus).handler(({ context: c }) => guard(() => c.models.status())),
  /** The models downloaded or downloading, loaded or not. */
  list: base.output(z.array(LocalModelView)).handler(({ context: c }) => c.models.list()),
  /** Hugging Face GGUF repositories and Ollama's library, each file's fit to this computer. */
  search: base
    .input(ModelSearch)
    .output(z.object({ entries: z.array(CatalogEntry), problems: z.array(z.string()) }))
    .handler(({ context: c, input }) => guard(() => c.models.search(input))),
  /** One model's files, sizes, fit and licence, before a download. */
  details: base
    .input(z.object({ source: ModelSource, id: z.string().min(1).max(200) }))
    .output(CatalogEntry)
    .handler(({ context: c, input }) => guard(() => c.models.details(input.source, input.id))),
  /** Starts a download (resumable, checksum-checked); progress comes as `model.progress` events. */
  download: base
    .input(ModelDownload)
    .output(LocalModelView)
    .handler(({ context: c, input }) => guard(() => c.models.download(input))),
  pause: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.models.pause(input.id))),
  resume: base
    .input(z.object({ id: Id }))
    .output(LocalModelView)
    .handler(({ context: c, input }) => guard(() => c.models.resume(input.id))),
  remove: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.models.remove(input.id))),
  /** Loads it, admitted like any work (ADR-050); answers once it's loaded and measured. */
  load: base
    .input(z.object({ id: Id }))
    .output(LocalModelView)
    .handler(({ context: c, input }) =>
      guard(async () => {
        await c.models.load(input.id);
        return c.models.view(c.models.get(input.id));
      }),
    ),
  unload: base
    .input(z.object({ id: Id }))
    .output(LocalModelView)
    .handler(({ context: c, input }) =>
      guard(async () => {
        await c.models.unload(input.id);
        return c.models.view(c.models.get(input.id));
      }),
    ),
  /** Keep loaded, idle minutes, context and GPU layers (automatic by default). */
  settings: base
    .input(ModelSettingsPatch)
    .output(LocalModelView)
    .handler(({ context: c, input }) => guard(() => c.models.setSettings(input))),
  /** Gives a role to a model, or takes it back (id null: the suggested one again). */
  setRole: base
    .input(z.object({ role: ModelRole, id: Id.nullable() }))
    .output(ModelsStatus)
    .handler(({ context: c, input }) =>
      guard(async () => {
        c.models.setRole(input.role, input.id);
        return c.models.status();
      }),
    ),
};
