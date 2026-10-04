import type {
  RcloneBackend,
  RcloneBackendSummary,
  RcloneExample,
  RcloneOption,
} from "@oraknid/contracts";

// Every provider rclone supports (ADR-046 → Changed 2026-10-04): its
// `config providers` schema read into the backends Oraknid offers, and the
// form made from one: the sub-provider first when it has them (s3's
// AWS, Hetzner, R2 …), its required options, the rest of its basic ones,
// the others under Advanced; each typed, secrets as password fields. The
// daemon checks what comes back against the same model.

/**
 * Backends that aren't a place of their own: they wrap another remote
 * (alias, crypt, union …), are this computer (local, memory), or only read
 * (http, doi, archive).
 */
export const NOT_OFFERED = new Set([
  "alias",
  "archive",
  "cache",
  "chunker",
  "combine",
  "compress",
  "crypt",
  "doi",
  "hasher",
  "http",
  "local",
  "memory",
  "union",
]);

/** How Oraknid reads the schema: a kept copy read another way is read again. */
export const RCLONE_SCHEMA_FORMAT = 1;

/** Signing in through a browser (`rclone authorize <backend>` gives a token). */
export const OAUTH_BACKENDS = new Set([
  "box",
  "drive",
  "dropbox",
  "google cloud storage",
  "google photos",
  "hidrive",
  "huaweidrive",
  "onedrive",
  "pcloud",
  "premiumizeme",
  "putio",
  "sharefile",
  "yandex",
  "zoho",
]);
/** A token and a client id, but no browser sign-in: rclone gets the token another way. */
const NO_AUTHORIZE = new Set(["mailru", "jottacloud", "linkbox", "filefabric", "shade"]);
/** rclone's own app signs in: these stay rclone's. */
const OAUTH_OWN = new Set([
  "token",
  "client_id",
  "client_secret",
  "auth_url",
  "token_url",
  "client_credentials",
]);

/** Object storage: the folder starts with a bucket. */
const BUCKET_BACKENDS = new Set([
  "azureblob",
  "b2",
  "google cloud storage",
  "oracleobjectstorage",
  "qingstor",
  "s3",
  "storj",
  "swift",
]);

const SHORT: Record<string, RcloneBackendSummary["short"]> = {
  drive: "drive",
  dropbox: "dropbox",
  mega: "mega",
};

/** A sensitive option that is a secret, not an address or a name. */
const SECRET_NAME =
  /secret|pass|token|cookie|grant|credentials|connection_string|sas_url|pem|(^|_)key$|private/;

interface RawExample {
  Value?: unknown;
  Help?: unknown;
  Provider?: unknown;
}
interface RawOption {
  Name?: unknown;
  Help?: unknown;
  Type?: unknown;
  DefaultStr?: unknown;
  Default?: unknown;
  Required?: unknown;
  Advanced?: unknown;
  IsPassword?: unknown;
  Sensitive?: unknown;
  Exclusive?: unknown;
  Hide?: unknown;
  Examples?: unknown;
  Provider?: unknown;
}
interface RawBackend {
  Name?: unknown;
  Description?: unknown;
  Prefix?: unknown;
  Aliases?: unknown;
  Hide?: unknown;
  Options?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A backend's name in a few words: "Amazon S3 Compliant Storage Providers including …" → the start. */
export function backendTitle(description: string, name: string): string {
  const d = (description || name).split(" including ")[0]?.trim() ?? name;
  const short = d.replace(/\.$/, "");
  // "seafile" → "Seafile", but "iCloud" stays.
  return /^[a-z][a-z]/.test(short) ? short.charAt(0).toUpperCase() + short.slice(1) : short;
}

/** One option as rclone describes it, or null when it is hidden (or rclone's own app's, for one that signs in). */
export function readRcloneOption(raw: unknown, oauth = false): RcloneOption | null {
  const o = (raw ?? {}) as RawOption;
  const name = str(o.Name);
  if (!/^[a-z0-9_]+$/.test(name)) return null;
  if (typeof o.Hide === "number" && o.Hide !== 0) return null;
  if (oauth && OAUTH_OWN.has(name)) return null;
  const password = o.IsPassword === true;
  const examples: RcloneExample[] = Array.isArray(o.Examples)
    ? (o.Examples as RawExample[]).map((e) => ({
        value: str(e.Value),
        help: str(e.Help),
        provider: str(e.Provider) || null,
      }))
    : [];
  let def = str(o.DefaultStr);
  if (!def && typeof o.Default !== "object" && o.Default !== undefined && o.Default !== null)
    def = String(o.Default);
  return {
    name,
    help: str(o.Help).trim(),
    type: str(o.Type) || "string",
    default: def,
    required: o.Required === true,
    advanced: o.Advanced === true,
    password,
    secret: password || (o.Sensitive === true && SECRET_NAME.test(name) && !/^public/.test(name)),
    exclusive: o.Exclusive === true,
    examples,
    provider: str(o.Provider) || null,
  };
}

/** rclone's `config providers` (JSON) as the backends Oraknid offers, by name. */
export function readRcloneSchema(raw: unknown): RcloneBackend[] {
  if (!Array.isArray(raw)) throw new Error("rclone's list of providers isn't one Oraknid reads.");
  const out: RcloneBackend[] = [];
  for (const b of raw as RawBackend[]) {
    const name = str(b.Name);
    if (!name || b.Hide === true || NOT_OFFERED.has(name)) continue;
    if (!/^[a-z0-9][a-z0-9 ]*$/.test(name)) continue;
    const rawOptions = Array.isArray(b.Options) ? (b.Options as RawOption[]) : [];
    const names = new Set(rawOptions.map((o) => str(o.Name)));
    const oauth =
      OAUTH_BACKENDS.has(name) ||
      (names.has("token") && names.has("client_id") && !NO_AUTHORIZE.has(name));
    const options = rawOptions
      .map((o) => readRcloneOption(o, oauth))
      .filter((o): o is RcloneOption => !!o);
    const description = str(b.Description);
    out.push({
      name,
      title: backendTitle(description, name),
      description,
      prefix: str(b.Prefix) || name,
      aliases: Array.isArray(b.Aliases) ? (b.Aliases as unknown[]).map(str).filter(Boolean) : [],
      oauth,
      bucket: BUCKET_BACKENDS.has(name),
      short: SHORT[name] ?? null,
      options,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export const summaryOf = ({ options: _, ...s }: RcloneBackend): RcloneBackendSummary => s;

/** Backends whose name, title, description or other names hold every word of `q`. */
export function searchBackends<T extends RcloneBackendSummary>(list: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const scored = list
    .map((b) => {
      const name = `${b.name} ${b.prefix} ${b.aliases.join(" ")}`.toLowerCase();
      const title = b.title.toLowerCase();
      const all = `${name} ${title} ${b.description.toLowerCase()}`;
      if (!words.every((w) => all.includes(w))) return null;
      // A name or title that starts with it first.
      const score = words.reduce(
        (s, w) => s + (name.startsWith(w) || title.startsWith(w) ? 0 : title.includes(w) ? 1 : 2),
        0,
      );
      return { b, score };
    })
    .filter((x): x is { b: T; score: number } => !!x);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.b);
}

/** rclone's condition on a sub-provider: "AWS,Minio", or "!AWS" for every other. */
export function matchesProvider(condition: string | null, provider: string): boolean {
  if (!condition || !provider) return true;
  const negate = condition.startsWith("!");
  const list = (negate ? condition.slice(1) : condition).split(",");
  return list.includes(provider) !== negate;
}

/** How an option is asked. */
export type FieldInput =
  | "bool"
  | "tristate"
  | "int"
  | "float"
  | "size"
  | "duration"
  | "choice"
  | "password"
  | "multiline"
  | "text";

export function inputOf(o: RcloneOption): FieldInput {
  if (o.type === "bool") return "bool";
  if (o.type === "Tristate") return "tristate";
  if (o.secret)
    return o.name === "key_pem" || /credentials/.test(o.name) ? "multiline" : "password";
  if (o.type === "int") return "int";
  if (o.type === "float64") return "float";
  if (o.type === "SizeSuffix") return "size";
  if (o.type === "Duration") return "duration";
  if (o.exclusive && o.examples.length) return "choice";
  return "text";
}

/** An option with its choices for this sub-provider. */
export type FormOption = RcloneOption & { input: FieldInput };

export interface FormModel {
  /** Which service, for a backend that serves several (s3, koofr, storj …): asked first. */
  provider: FormOption | null;
  /** Needed: asked first. */
  required: FormOption[];
  /** The rest of its everyday options. */
  basic: FormOption[];
  /** Under Advanced. */
  advanced: FormOption[];
}

/**
 * The form for a backend, for the sub-provider chosen (`values.provider`):
 * options for other sub-providers left out, each once, its choices those
 * of this sub-provider.
 */
export function formModel(b: RcloneBackend, values: Record<string, string> = {}): FormModel {
  const sub = b.options.find((o) => o.name === "provider" && o.examples.length > 0) ?? null;
  const chosen = sub ? (values.provider ?? "") : "";
  const seen = new Set<string>();
  const model: FormModel = {
    provider: sub ? { ...sub, input: "choice", required: true } : null,
    required: [],
    basic: [],
    advanced: [],
  };
  for (const o of b.options) {
    if (o === sub || seen.has(o.name)) continue;
    // Before a service is chosen, only what every service has.
    if (sub && !chosen && o.provider) continue;
    if (!matchesProvider(o.provider, chosen)) continue;
    seen.add(o.name);
    const examples = o.examples.filter((e) => matchesProvider(e.provider, chosen));
    const f: FormOption = { ...o, examples, input: "text" };
    f.input = inputOf(f);
    if (f.required && !f.default && !f.advanced) model.required.push(f);
    else if (f.advanced) model.advanced.push(f);
    else model.basic.push(f);
  }
  return model;
}

export const formOptions = (m: FormModel): FormOption[] => [
  ...(m.provider ? [m.provider] : []),
  ...m.required,
  ...m.basic,
  ...m.advanced,
];

const PATTERNS: Partial<Record<FieldInput, [RegExp, string]>> = {
  bool: [/^(true|false)$/, "true or false"],
  tristate: [/^(true|false)$/, "true or false"],
  int: [/^-?\d+$/, "a whole number"],
  float: [/^-?\d+(\.\d+)?$/, "a number"],
  size: [
    /^(off|-1|\d+(\.\d+)?\s*([bkmgtpe](i?b)?|[kmgtpe]i)?)$/i,
    "a size such as 64M, 5Gi or off",
  ],
  duration: [
    /^(off|\d+(\.\d+)?|(\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d|w|M|y))+)$/,
    "a duration such as 30s, 5m or 1h30m",
  ],
};

/** A value as it goes into the config: one line (a PEM key's line breaks as \n, as rclone wants). */
export function configValue(o: RcloneOption, value: string): string {
  if (o.name === "key_pem") return value.trim().replace(/\r?\n/g, "\\n");
  if (/credentials/.test(o.name)) return value.trim().replace(/\s*\r?\n\s*/g, " ");
  return value.trim();
}

export interface CheckedOptions {
  /** Ready for the config, the empty ones left out. */
  values: Record<string, string>;
  /** What is wrong, by option. */
  errors: Record<string, string>;
}

/** What a form gives, checked against the backend's options. */
export function checkOptions(b: RcloneBackend, given: Record<string, string>): CheckedOptions {
  const model = formModel(b, given);
  const fields = new Map(formOptions(model).map((o) => [o.name, o]));
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const [name, raw] of Object.entries(given)) {
    const o = fields.get(name);
    if (!o) {
      errors[name] = b.options.some((x) => x.name === name)
        ? `${name} isn't one for this service.`
        : `${b.title} has no option ${name}.`;
      continue;
    }
    const v = configValue(o, raw);
    if (!v) continue;
    if (/[\r\n]/.test(v)) {
      errors[name] = "It can't hold a line break.";
      continue;
    }
    const pattern = PATTERNS[o.input];
    if (pattern && !pattern[0].test(v)) {
      errors[name] = `It should be ${pattern[1]}.`;
      continue;
    }
    if ((o.exclusive || o === model.provider) && o.examples.length) {
      if (!o.examples.some((e) => e.value === v)) {
        errors[name] = `It should be one of: ${o.examples.map((e) => e.value || '""').join(", ")}.`;
        continue;
      }
    }
    values[name] = v;
  }
  if (model.provider && !values.provider && !errors.provider)
    errors.provider = "Say which service it is.";
  for (const o of model.required)
    if (!values[o.name] && !errors[o.name]) errors[o.name] = "It's needed.";
  return { values, errors };
}
