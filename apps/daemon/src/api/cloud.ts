import {
  CloudAuthorization,
  CloudListing,
  CloudPath,
  CloudPlacement,
  CloudProviderPatch,
  CloudProviderView,
  CloudStatus,
  Id,
  NewCloudProvider,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { Downloads } from "../cloud/routes.ts";
import type { Cloud } from "../cloud/service.ts";

// Cloud storage (ADR-046, API-Contract → cloud). Adding, changing and
// removing a provider are home only for a standard device (auth/lock.ts →
// HOME_ONLY); files move in and out over HTTP (cloud/routes.ts), only on
// this computer.

const base = os.$context<{ cloud: Cloud; downloads: Downloads; remote: boolean }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(
        /^No (cloud provider|file|folder)/.test(error.message)
          ? "NOT_FOUND"
          : /already/.test(error.message)
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

/** A download comes to a browser on this computer. */
export const notAway = (remote: boolean) => {
  if (remote)
    throw new ORPCError("FORBIDDEN", {
      message:
        "Downloads come to a browser on the computer running Oraknid; away from home they aren't available yet.",
    });
};

const FileRef = z.object({ providerId: Id, path: CloudPath });

export const cloudRouter = {
  status: base.output(CloudStatus).handler(({ context: c }) => guard(() => c.cloud.status())),
  providers: base
    .output(z.array(CloudProviderView))
    .handler(({ context: c }) => guard(() => c.cloud.providers())),
  addProvider: base
    .input(NewCloudProvider)
    .output(CloudProviderView)
    .handler(({ context: c, input }) => guard(() => c.cloud.addProvider(input))),
  updateProvider: base
    .input(CloudProviderPatch)
    .output(CloudProviderView)
    .handler(({ context: c, input }) => guard(() => c.cloud.updateProvider(input))),
  /** The priority order: provider ids, first first. */
  reorder: base
    .input(z.object({ ids: z.array(Id).max(100) }))
    .handler(({ context: c, input }) => guard(() => c.cloud.reorder(input.ids))),
  /** Gone from Oraknid; its files stay in the account. */
  removeProvider: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.cloud.removeProvider(input.id))),
  /** Used and free space, asked again. */
  checkProvider: base
    .input(z.object({ id: Id }))
    .output(CloudProviderView)
    .handler(({ context: c, input }) => guard(() => c.cloud.check(input.id))),
  /** Google Drive or Dropbox: rclone's sign-in, its address to open in a browser here. */
  authorizeStart: base
    .input(z.object({ kind: z.enum(["drive", "dropbox"]) }))
    .output(CloudAuthorization)
    .handler(({ context: c, input }) => guard(() => c.cloud.authorizeStart(input.kind))),
  authorizeStatus: base
    .input(z.object({ session: z.string().min(1).max(64) }))
    .output(CloudAuthorization)
    .handler(({ context: c, input }) => guard(() => c.cloud.authorizeStatus(input.session))),
  authorizeCancel: base
    .input(z.object({ session: z.string().min(1).max(64) }))
    .handler(({ context: c, input }) => guard(() => c.cloud.authorizeCancel(input.session))),
  placement: base
    .output(CloudPlacement)
    .handler(({ context: c }) => guard(() => c.cloud.placement())),
  setPlacement: base
    .input(CloudPlacement)
    .output(CloudPlacement)
    .handler(({ context: c, input }) => guard(() => c.cloud.setPlacement(input))),
  /** Where a file of this size would go now, or why none can take it. */
  place: base
    .input(z.object({ size: z.number().int().min(0), providerId: Id.nullable().optional() }))
    .output(z.object({ providerId: Id.nullable(), refused: z.string().nullable() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        try {
          return {
            providerId: await c.cloud.place(input.size, input.providerId ?? null),
            refused: null,
          };
        } catch (error) {
          return { providerId: null, refused: (error as Error).message };
        }
      }),
    ),
  list: base
    .input(z.object({ path: CloudPath.default("") }))
    .output(CloudListing)
    .handler(({ context: c, input }) => guard(() => c.cloud.list(input.path))),
  search: base
    .input(z.object({ q: z.string().max(200), path: CloudPath.default("") }))
    .output(CloudListing)
    .handler(({ context: c, input }) => guard(() => c.cloud.search(input.q, input.path))),
  /** A file renamed or moved, within its provider or to another. */
  move: base
    .input(FileRef.extend({ toPath: CloudPath, toProviderId: Id.nullable().optional() }))
    .handler(({ context: c, input }) => guard(() => c.cloud.move(input))),
  /** A folder renamed or moved, in every provider holding it. */
  moveFolder: base
    .input(z.object({ path: CloudPath, toPath: CloudPath }))
    .handler(({ context: c, input }) => guard(() => c.cloud.moveFolder(input.path, input.toPath))),
  /** The web page asks first. */
  deleteFile: base
    .input(FileRef)
    .handler(({ context: c, input }) =>
      guard(() => c.cloud.deleteFile(input.providerId, input.path)),
    ),
  deleteFolder: base
    .input(z.object({ path: CloudPath }))
    .handler(({ context: c, input }) => guard(() => c.cloud.deleteFolder(input.path))),
  /** A link to download a file, good once and for two minutes. */
  downloadLink: base
    .input(FileRef)
    .output(z.object({ url: z.string(), expiresAt: z.number() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        notAway(c.remote);
        const st = await c.cloud.stat(input.providerId, input.path);
        if (!st || st.isDir) throw new Error(`No file ${input.path}.`);
        return c.downloads.mint(() => c.cloud.open(input.providerId, input.path));
      }),
    ),
};
