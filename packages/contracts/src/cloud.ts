import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Cloud storage (ADR-046): my storage accounts, through rclone, seen as one
// pool. Credentials go into Oraknid's encrypted rclone config and never come
// back in a view.

export const CloudKind = z.enum(["s3", "drive", "dropbox", "mega"]);
export type CloudKind = z.infer<typeof CloudKind>;

/** Which S3-compatible service: each sets rclone's `provider` and what the form asks. */
export const S3Preset = z.enum(["Minio", "AWS", "R2", "B2", "Wasabi", "Other"]);
export type S3Preset = z.infer<typeof S3Preset>;

/** A folder inside an account or a bucket: no `..`, no leading slash. */
export const CloudPath = z
  .string()
  .max(1024)
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "."), "no . or .. in a path")
  .refine((p) => !p.startsWith("/"), "a path inside the pool, without a leading /")
  .refine((p) => !/[\0\r\n]/.test(p), "no control characters in a path");
export type CloudPath = z.infer<typeof CloudPath>;

const Name = z.string().min(1).max(80);
const Folder = CloudPath.default("");
/** A space limit I set, for a provider that can't say its own (object storage). */
const Limit = z
  .number()
  .int()
  .min(1)
  .max(2 ** 53)
  .nullable()
  .default(null);

export const NewCloudProvider = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("s3"),
    name: Name,
    preset: S3Preset,
    /** The service's address; AWS's own when null. */
    endpoint: z.string().url().max(500).nullable().default(null),
    region: z.string().max(64).nullable().default(null),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(
        /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/,
        "a bucket's name: lowercase letters, digits, . and -",
      ),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
    folder: Folder,
    limitBytes: Limit,
    /** Pay as you go: never full. */
    unlimited: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("drive"),
    name: Name,
    /** The sign-in started with `cloud.authorizeStart`, once it is ready. */
    authSession: z.string().min(8).max(64),
    folder: Folder,
  }),
  z.object({
    kind: z.literal("dropbox"),
    name: Name,
    authSession: z.string().min(8).max(64),
    folder: Folder,
  }),
  z.object({
    kind: z.literal("mega"),
    name: Name,
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
    folder: Folder,
  }),
]);
export type NewCloudProvider = z.infer<typeof NewCloudProvider>;

export const CloudProviderPatch = z.object({
  id: Id,
  name: Name.optional(),
  limitBytes: z
    .number()
    .int()
    .min(1)
    .max(2 ** 53)
    .nullable()
    .optional(),
  unlimited: z.boolean().optional(),
});
export type CloudProviderPatch = z.infer<typeof CloudProviderPatch>;

/** Where a provider's free space comes from. */
export const CloudSpace = z.enum(["provider", "limit", "unlimited", "unknown"]);
export type CloudSpace = z.infer<typeof CloudSpace>;

export const CloudProviderView = z.object({
  id: Id,
  name: z.string(),
  kind: CloudKind,
  /** In words: "MinIO · bucket photos", "Google Drive · Oraknid/". */
  detail: z.string(),
  preset: S3Preset.nullable(),
  /** The bucket and folder, or the folder in the account, everything of mine in the pool lives under. */
  root: z.string(),
  space: CloudSpace,
  usedBytes: z.number().nullable(),
  /** null: unknown; with `unlimited`, never full. */
  freeBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  limitBytes: z.number().nullable(),
  unlimited: z.boolean(),
  /** Its place in the priority order (Automatic → priority), 0 first. */
  priority: z.number().int(),
  checkedAt: Timestamp.nullable(),
  /** What went wrong at the last check, in words. */
  error: z.string().nullable(),
  createdAt: Timestamp,
});
export type CloudProviderView = z.infer<typeof CloudProviderView>;

/** One entry of the pool: a file in one provider, or a folder (merged across them). */
export const CloudEntry = z.object({
  /** Its path in the pool. */
  path: z.string(),
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().nullable(),
  modTime: z.string().nullable(),
  mimeType: z.string().nullable(),
  /** A file's provider; a folder's are in `providers`. */
  providerId: Id.nullable(),
  providers: z.array(Id),
});
export type CloudEntry = z.infer<typeof CloudEntry>;

export const CloudListing = z.object({
  path: z.string(),
  entries: z.array(CloudEntry),
  /** A provider that couldn't be read, and why. */
  errors: z.array(z.object({ providerId: Id, name: z.string(), error: z.string() })),
  /** A search stopped at its limit. */
  truncated: z.boolean(),
});
export type CloudListing = z.infer<typeof CloudListing>;

/** Where an upload goes (ADR-046). */
export const CloudPlacement = z.object({
  mode: z.enum(["auto", "provider"]),
  /** Automatic: the most free space, the priority order, or by size (large files to object storage). */
  rule: z.enum(["free", "priority", "size"]),
  /** The one I pick, for `provider`. */
  providerId: Id.nullable(),
  /** By size: from this size a file is large. */
  largeFromBytes: z
    .number()
    .int()
    .min(1)
    .default(100 * 1024 * 1024),
});
export type CloudPlacement = z.infer<typeof CloudPlacement>;

export const CloudStatus = z.object({
  rclone: z.object({
    found: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable(),
    /** How to install it, when it's missing. */
    fix: z.string().nullable(),
  }),
});
export type CloudStatus = z.infer<typeof CloudStatus>;

/** A Google Drive or Dropbox sign-in through rclone's own authorization. */
export const CloudAuthorization = z.object({
  session: z.string(),
  kind: z.enum(["drive", "dropbox"]),
  state: z.enum(["waiting", "ready", "failed"]),
  /** The address to open in a browser on this computer. */
  url: z.string().nullable(),
  error: z.string().nullable(),
});
export type CloudAuthorization = z.infer<typeof CloudAuthorization>;

/** An upload's or a download's progress, on the live socket (`storage`); never stored. */
export const CloudTransfer = z.object({
  id: z.string(),
  name: z.string(),
  /** receive: from the browser to Oraknid; send: from Oraknid to the provider. */
  phase: z.enum(["receive", "send", "done", "failed"]),
  bytes: z.number(),
  total: z.number().nullable(),
  providerId: Id.nullable(),
  error: z.string().nullable(),
});
export type CloudTransfer = z.infer<typeof CloudTransfer>;
