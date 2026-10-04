import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import { readSetting, writeSetting } from "../settings.ts";

// The lock (ADR-029): a PIN the daemon checks, and an unlocked session
// per device, in memory only. A device token alone opens nothing but
// the lock.

export const PIN_SETTING = "lock.pin";
export const IDLE_SETTING = "lock.idleMinutes";
export const IDLE_CHOICES = [5, 15, 60, 240] as const;

const PinRecord = z.object({ salt: z.string(), hash: z.string(), n: z.number().int() });
const IdleMinutes = z
  .number()
  .int()
  .min(1)
  .max(24 * 60);

/** 6 to 12 digits, or a passphrase of 8 characters or more. */
export const Pin = z
  .string()
  .refine((p) => /^\d{6,12}$/.test(p) || (p.length >= 8 && p.length <= 128 && /\D/.test(p)), {
    message: "A PIN is 6 to 12 digits, or a passphrase of at least 8 characters.",
  });

const SESSION_MAX_MS = 12 * 3600_000;
const SLOW_FROM = 5;
const REVOKE_AT = 10;
const GLOBAL_WINDOW_MS = 3600_000;
const GLOBAL_MAX = 20;
const N = 2 ** 15;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** scrypt off the event loop: a guess costs time, the daemon doesn't. */
const derive = (pin: string, salt: string, n: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      pin.normalize("NFKC"),
      Buffer.from(salt, "hex"),
      32,
      { N: n, r: 8, p: 1, maxmem: 128 * n * 8 * 2 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );

interface Session {
  device: string;
  createdAt: number;
  lastActive: number;
}

export class LockedError extends Error {
  readonly code = "LOCKED";
}

export class AppLock {
  /** Session hash → session. */
  readonly #sessions = new Map<string, Session>();
  /** Wrong tries per device, and when the next try is allowed. */
  readonly #wrong = new Map<string, { count: number; until: number }>();
  /** Times of recent wrong tries, all devices. */
  #recentWrong: number[] = [];
  /** Away from home, unlocking stops until then (too many wrong tries everywhere). */
  #remoteBlockedUntil = 0;
  readonly #checking = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly revokeDevice: (id: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  hasPin(): boolean {
    return readSetting(this.db, PIN_SETTING, PinRecord.nullable(), null) !== null;
  }

  idleMinutes(): number {
    return readSetting(this.db, IDLE_SETTING, IdleMinutes, 15);
  }

  setIdleMinutes(m: number) {
    writeSetting(this.db, IDLE_SETTING, IdleMinutes, m, this.now());
  }

  status(device: string, session: string | undefined) {
    const wrong = this.#wrong.get(device);
    return {
      pinSet: this.hasPin(),
      unlocked: this.check(device, session, false),
      idleMinutes: this.idleMinutes(),
      triesLeft: REVOKE_AT - (wrong?.count ?? 0),
      waitUntil: wrong && wrong.until > this.now() ? wrong.until : null,
    };
  }

  /** The first PIN (no current one), or a new one with the current one. Only from this computer. */
  async setPin(
    device: string,
    current: string | null,
    next: string,
    remote: boolean,
  ): Promise<{ session: string }> {
    if (remote)
      throw new Error("The PIN can only be set or changed on the computer running Oraknid.");
    Pin.parse(next);
    if (this.hasPin()) {
      if (current === null || !(await this.#matches(current))) {
        this.#failed(device, remote);
        throw new Error("The current PIN is wrong.");
      }
    }
    const salt = randomBytes(16).toString("hex");
    writeSetting(
      this.db,
      PIN_SETTING,
      PinRecord.nullable(),
      { salt, hash: (await derive(next, salt, N)).toString("hex"), n: N },
      this.now(),
    );
    // Every other session ends: whoever had one must know the new PIN.
    this.#sessions.clear();
    this.bus.publish({
      type: "lock.pin-set",
      topic: "overview",
      jobId: null,
      payload: {},
      actor: "owner",
    });
    return { session: this.#open(device) };
  }

  /** `oraknid pin reset`: the CLI only, on this computer. */
  resetPin() {
    writeSetting(this.db, PIN_SETTING, PinRecord.nullable(), null, this.now());
    this.#sessions.clear();
    this.#wrong.clear();
    this.bus.publish({
      type: "lock.pin-reset",
      topic: "overview",
      jobId: null,
      payload: {},
      actor: "owner",
    });
  }

  async unlock(
    device: string,
    pin: string,
    remote: boolean,
  ): Promise<{ session: string; expiresAt: number }> {
    await this.verify(device, pin, remote);
    return { session: this.#open(device), expiresAt: this.now() + SESSION_MAX_MS };
  }

  /** The PIN asked again before something big (ADR-030); wrong tries count as at the lock. */
  async verify(device: string, pin: string, remote: boolean): Promise<void> {
    if (!this.hasPin()) throw new Error("Set a PIN first, on the computer running Oraknid.");
    const t = this.now();
    if (remote && this.#remoteBlockedUntil > t)
      throw new Error(
        "Too many wrong PINs: unlocking away from home is stopped for now. Unlock on your computer.",
      );
    const wrong = this.#wrong.get(device);
    if (wrong && wrong.until > t)
      throw new Error(
        `Too many wrong PINs: try again in ${Math.ceil((wrong.until - t) / 1000)} s.`,
      );
    // One guess at a time per device: a burst can't outrun the count.
    if (this.#checking.has(device)) throw new Error("Checking the last try…");
    this.#checking.add(device);
    let ok: boolean;
    try {
      ok = await this.#matches(pin);
    } finally {
      this.#checking.delete(device);
    }
    if (!ok) {
      const left = this.#failed(device, remote);
      throw new Error(
        left > 0
          ? `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left before this device is unpaired.`
          : "Wrong PIN. This device was unpaired; pair it again from your computer.",
      );
    }
    this.#wrong.delete(device);
  }

  /** Whether this device's session is unlocked; a check that counts as activity unless `touch` is false. */
  check(device: string, session: string | undefined, touch = true): boolean {
    if (!session) return false;
    const s = this.#sessions.get(sha256(session));
    if (!s || s.device !== device) return false;
    const t = this.now();
    if (t - s.lastActive > this.idleMinutes() * 60_000 || t - s.createdAt > SESSION_MAX_MS) {
      this.#sessions.delete(sha256(session));
      return false;
    }
    if (touch) s.lastActive = t;
    return true;
  }

  /** This device's session, or every one ("Lock now"). */
  lock(device: string | null, session?: string) {
    if (device === null) this.#sessions.clear();
    else if (session) this.#sessions.delete(sha256(session));
    else for (const [k, s] of this.#sessions) if (s.device === device) this.#sessions.delete(k);
    this.bus.publish({
      type: "lock.locked",
      topic: "overview",
      jobId: null,
      payload: { device },
      actor: "owner",
    });
  }

  #open(device: string): string {
    const session = randomBytes(32).toString("base64url");
    const t = this.now();
    this.#sessions.set(sha256(session), { device, createdAt: t, lastActive: t });
    return session;
  }

  async #matches(pin: string): Promise<boolean> {
    const rec = readSetting(this.db, PIN_SETTING, PinRecord.nullable(), null);
    if (!rec) return false;
    const want = Buffer.from(rec.hash, "hex");
    const got = await derive(pin, rec.salt, rec.n);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Counts a wrong try; returns how many are left before the device is unpaired. */
  #failed(device: string, remote: boolean): number {
    const t = this.now();
    const count = (this.#wrong.get(device)?.count ?? 0) + 1;
    const until = count >= SLOW_FROM ? t + 30_000 * 2 ** (count - SLOW_FROM) : 0;
    this.#wrong.set(device, { count, until });
    this.#recentWrong = [...this.#recentWrong.filter((x) => x > t - GLOBAL_WINDOW_MS), t];
    if (this.#recentWrong.length > GLOBAL_MAX) this.#remoteBlockedUntil = t + GLOBAL_WINDOW_MS;
    this.bus.publish({
      type: "lock.wrong-pin",
      topic: "overview",
      jobId: null,
      payload: { device, count, remote, ...(count === SLOW_FROM ? { notify: true } : {}) },
      actor: "oraknid",
    });
    if (count >= REVOKE_AT && device !== "cli") {
      this.#wrong.delete(device);
      this.lock(device);
      this.revokeDevice(device);
      return 0;
    }
    return REVOKE_AT - count;
  }
}

/** The unlocked session a request carries: a header, or `?unlock=` on the sockets. */
export function unlockOf(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string | undefined {
  const h = headers["x-oraknid-unlock"];
  if (typeof h === "string" && h) return h;
  if (url === undefined) return undefined;
  return new URL(url, "http://x").searchParams.get("unlock") ?? undefined;
}

/** What a locked device may still call. */
export const LOCK_FREE = new Set(["/lock/status", "/lock/unlock"]);

/**
 * What a device away from home may not do, even unlocked (ADR-029): nothing
 * that opens a new way in, widens what agents may touch or sends my data
 * somewhere new. Those are done at home.
 */
/** Home only whatever the device's rights (ADR-030): a device can't widen itself or mint others. */
export const ALWAYS_HOME = [
  "/secrets/",
  "/nest/configure",
  "/nest/register",
  "/nest/pairAway",
  "/devices/pairStart",
  "/devices/revoke",
  "/devices/setRights",
  "/lock/setPin",
  "/lock/setIdle",
];

export const HOME_ONLY = [
  ...ALWAYS_HOME,
  "/policies/update",
  "/projects/create",
  "/projects/createFrom",
  "/projects/setPolicy",
  "/projects/setServers",
  "/projects/setServerRole",
  // A project's repos (ADR-042): adding one may clone or make a folder on this computer.
  "/projects/addRepo",
  "/projects/detectRepos",
  "/projects/removeRepo",
  "/projects/updateRepo",
  "/projects/setLocalPorts",
  "/projects/delete",
  "/servers/add",
  "/servers/update",
  "/servers/setup",
  "/servers/acceptHostKey",
  "/servers/editState",
  "/servers/remove",
  // Backups (ADR-044): a plan's password and destination, keys, and restoring.
  "/backups/createPlan",
  "/backups/updatePlan",
  "/backups/removePlan",
  "/backups/prepareRestore",
  "/backups/restore",
  "/backups/importKey",
  "/backups/exportKey",
  "/backups/removeKey",
  // Cloud storage (ADR-046): a provider's credentials, and the sign-in (a browser here anyway).
  "/cloud/addProvider",
  "/cloud/updateProvider",
  "/cloud/removeProvider",
  "/cloud/authorizeStart",
  "/cloud/addRclone",
  "/cloud/answerRclone",
  // Restarting a container or a service on a server (ADR-043); reading stays open.
  "/servers/restart",
  // GitHub's accounts, a new repository and a project's link (ADR-038, ADR-040); reading stays open.
  "/github/addAccount",
  "/github/removeAccount",
  "/github/createRepo",
  "/projects/setGitHub",
  "/mail/addAccount",
  "/mail/testAccount",
  "/mail/updateAccount",
  "/mail/removeAccount",
  "/mail/reconnect",
  "/tools/create",
  "/tools/update",
  "/tools/remove",
  "/skills/upload",
  "/skills/edit",
  "/skills/remove",
  "/legs/create",
  "/legs/update",
  "/legs/remove",
  "/legs/loginStart",
  "/legs/loginFinish",
  "/legs/setProfile",
  "/silk/importMirror",
  "/settings/setTerminal",
  "/settings/setEyeModels",
  "/settings/setEyeLeg",
  "/notifications/update",
  "/notifications/configureEmail",
  "/storage/prune",
  "/jobs/setWaivers",
  "/jobs/setRules",
];

/** What a device away from home may call: with full rights, all but ALWAYS_HOME (ADR-030). */
export const remoteAllowed = (path: string, full = false) =>
  !(full ? ALWAYS_HOME : HOME_ONLY).some((p) => path.startsWith(p));
