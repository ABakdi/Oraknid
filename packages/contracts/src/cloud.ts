import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Cloud storage (ADR-046): my storage accounts, through rclone, seen as one
// pool. Credentials go into Oraknid's encrypted rclone config and never come
// back in a view.

/** The short forms, and `rclone`: any other backend rclone supports, from its schema. */
export const CloudKind = z.enum(["s3", "drive", "dropbox", "mega", "rclone"]);
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
  /** rclone's backend: s3, drive, dropbox, mega, or the one picked from its list (sftp, onedrive …). */
  backend: z.string(),
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

/** A sign-in through rclone's own authorization (Google Drive, Dropbox, OneDrive, Box …). */
export const CloudAuthorization = z.object({
  session: z.string(),
  /** The backend signed in to: drive, dropbox, or any other that signs in through a browser. */
  kind: z.string(),
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

// ── Every provider rclone supports (ADR-046 → Changed 2026-10-04)

/** A backend's name as rclone knows it ("sftp", "google photos"). */
export const RcloneBackendName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9 ]*$/, "a backend's name: lowercase letters, digits and spaces");

/** An option's name in rclone's config. */
export const RcloneOptionName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "an option's name: lowercase letters, digits and _");

/** One choice of an option; `provider`: only for these sub-providers (rclone's condition). */
export const RcloneExample = z.object({
  value: z.string(),
  help: z.string(),
  provider: z.string().nullable(),
});
export type RcloneExample = z.infer<typeof RcloneExample>;

/** One option of a backend, as rclone describes it (`config providers`), hidden ones left out. */
export const RcloneOption = z.object({
  name: RcloneOptionName,
  help: z.string(),
  /** rclone's type: string, bool, int, SizeSuffix, Duration, Tristate, CommaSepList … */
  type: z.string(),
  /** rclone's default, as text ("" when none). */
  default: z.string(),
  required: z.boolean(),
  advanced: z.boolean(),
  /** rclone keeps it obscured (IsPassword): Oraknid obscures it through rclone's stdin. */
  password: z.boolean(),
  /** A password field, kept only in the encrypted config (passwords, keys, tokens). */
  secret: z.boolean(),
  /** Only one of the examples. */
  exclusive: z.boolean(),
  examples: z.array(RcloneExample),
  /** Only for these sub-providers (s3's provider …): "AWS,Minio", or "!AWS" for all but. */
  provider: z.string().nullable(),
});
export type RcloneOption = z.infer<typeof RcloneOption>;

export const RcloneBackendSummary = z.object({
  name: RcloneBackendName,
  /** In words: "Microsoft OneDrive", "SSH/SFTP". */
  title: z.string(),
  description: z.string(),
  /** Its prefix for flags (`--sftp-…`). */
  prefix: z.string(),
  /** Other names to find it by. */
  aliases: z.array(z.string()),
  /** Signs in through a browser with `rclone authorize` (OAuth). */
  oauth: z.boolean(),
  /** Keeps files in buckets: the folder starts with the bucket. */
  bucket: z.boolean(),
  /** Oraknid's own short form for it (Google Drive, Dropbox, MEGA). */
  short: z.enum(["drive", "dropbox", "mega"]).nullable(),
});
export type RcloneBackendSummary = z.infer<typeof RcloneBackendSummary>;

export const RcloneBackend = RcloneBackendSummary.extend({ options: z.array(RcloneOption) });
export type RcloneBackend = z.infer<typeof RcloneBackend>;

/** rclone's list of backends, for the add dialog. */
export const RcloneBackends = z.object({
  /** The rclone it came from ("rclone v1.75.1"). */
  version: z.string().nullable(),
  backends: z.array(RcloneBackendSummary),
});
export type RcloneBackends = z.infer<typeof RcloneBackends>;

/** A provider of any backend, from the form made of rclone's schema. */
export const NewRcloneProvider = z.object({
  name: Name,
  backend: RcloneBackendName,
  /** The options set in the form (empty ones left out); secrets go only into the encrypted config. */
  options: z.record(RcloneOptionName, z.string().max(65_536)).default({}),
  /** A finished sign-in (`cloud.authorizeStart` with this backend), for one that signs in through a browser. */
  authSession: z.string().min(8).max(64).nullable().default(null),
  folder: Folder,
  limitBytes: Limit,
  unlimited: z.boolean().default(false),
});
export type NewRcloneProvider = z.infer<typeof NewRcloneProvider>;

/** A question rclone asks while it sets a provider up (OneDrive's drive, a code …). */
export const RcloneQuestion = z.object({
  /** The add in progress, to answer or cancel. */
  pending: z.string(),
  option: RcloneOption,
  /** What went wrong with the last answer, in rclone's words. */
  error: z.string().nullable(),
});
export type RcloneQuestion = z.infer<typeof RcloneQuestion>;

/** An add's step: the provider, added; or rclone's next question. */
export const CloudAddStep = z.object({
  provider: CloudProviderView.nullable(),
  question: RcloneQuestion.nullable(),
});
export type CloudAddStep = z.infer<typeof CloudAddStep>;
