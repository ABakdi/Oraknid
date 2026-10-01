import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { devices } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";

const MAX_FAILURES = 5;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Paired devices (Security → The daemon's own surface): every client
 * carries a token. The CLI's comes from a 0600 file only my user can
 * read; a browser or phone gets one by entering a short code that
 * `oraknid pair` (or the UI on this machine) shows. Tokens are stored
 * only as hashes, and any device can be revoked.
 */
export class Devices {
  /** The CLI's token, new at every start, written to the runtime file. */
  readonly cliToken = randomBytes(32).toString("hex");
  readonly #codes = new Map<string, number>();
  readonly #seen = new Map<string, number>();
  /** Wrong codes since the last good one (Audit 1 → S1-04). */
  #failures = 0;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** A six-digit code, valid five minutes, usable once. */
  startPairing(): { code: string; expiresAt: number } {
    for (const [c, exp] of this.#codes) if (exp < this.now()) this.#codes.delete(c);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.now() + 5 * 60_000;
    this.#codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  completePairing(code: string, name: string): { deviceId: string; token: string } {
    const exp = this.#codes.get(code);
    this.#codes.delete(code);
    if (!exp || exp < this.now()) {
      // Guessing a six-digit code is hopeless: five wrong codes cancel every open one.
      if (++this.#failures >= MAX_FAILURES) {
        const open = this.#codes.size;
        this.#codes.clear();
        this.#failures = 0;
        this.bus.publish({
          type: "device.pairing-locked",
          topic: "overview",
          jobId: null,
          payload: { openCodes: open },
          actor: "eye",
        });
        throw new Error(
          "Too many wrong codes: every open code was cancelled. Ask for a new one with: oraknid pair",
        );
      }
      throw new Error("That code is wrong or has expired. Ask for a new one with: oraknid pair");
    }
    this.#failures = 0;
    const token = randomBytes(32).toString("hex");
    const id = newId(this.now());
    this.db
      .insert(devices)
      .values({ id, name, publicKey: "", tokenHash: sha256(token), pairedAt: this.now() })
      .run();
    this.bus.publish({
      type: "device.paired",
      topic: "overview",
      jobId: null,
      payload: { id, name },
      actor: "owner",
    });
    return { deviceId: id, token };
  }

  /** Who a token belongs to: "cli", a device id, or null. */
  identify(token: string | undefined): string | null {
    if (!token) return null;
    if (
      token.length === this.cliToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(this.cliToken))
    )
      return "cli";
    const device = this.db
      .select()
      .from(devices)
      .where(and(eq(devices.tokenHash, sha256(token)), isNull(devices.revokedAt)))
      .get();
    if (!device) return null;
    // Last seen, at most once a minute.
    if ((this.#seen.get(device.id) ?? 0) < this.now() - 60_000) {
      this.#seen.set(device.id, this.now());
      this.db
        .update(devices)
        .set({ lastSeenAt: this.now() })
        .where(eq(devices.id, device.id))
        .run();
    }
    return device.id;
  }

  list() {
    return this.db
      .select({
        id: devices.id,
        name: devices.name,
        pairedAt: devices.pairedAt,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .orderBy(devices.id)
      .all();
  }

  revoke(id: string) {
    const d = this.db.select().from(devices).where(eq(devices.id, id)).get();
    if (!d) throw new Error(`No device ${id}.`);
    this.db.update(devices).set({ revokedAt: this.now() }).where(eq(devices.id, id)).run();
    this.bus.publish({
      type: "device.revoked",
      topic: "overview",
      jobId: null,
      payload: { id, name: d.name },
      actor: "owner",
    });
  }
}

/** The token a request carries: a Bearer header, or `?token=` (a browser cannot set headers on a WebSocket). */
export function tokenOf(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const q = new URL(url ?? "/", "http://x").searchParams.get("token");
  return q ?? undefined;
}
