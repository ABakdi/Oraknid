import type { SecretStore, SecretStoreStatus } from "../secrets.ts";
import { HelperClient, KeychainTimeout } from "./keychain-helper.ts";
import { type Gate, type SecretServiceState, secretServiceGate } from "./secret-service-gate.ts";

/** The service the entries of before were kept under, one for every data folder (Audit 2, S2-23). */
export const KEYCHAIN_SERVICE = "oraknid";

/** The service of one data folder's entries: `oraknid:<its keychain id>`. */
export function keychainService(id: string): string {
  return `${KEYCHAIN_SERVICE}:${id}`;
}

/** A keychain store over one service, which can name others of the same keychain. */
export interface KeychainStore extends SecretStore {
  /** `waiting`: not there yet, worth asking again later (ADR-070); else, none on this machine. */
  probe(): Promise<SecretStoreStatus & { waiting?: boolean }>;
  /** The service its entries are kept under. */
  readonly service: string;
  /** The names of this service's entries (never their values). */
  names(): Promise<string[]>;
  /** The same keychain, another service: one data folder's entries (S2-23). */
  scoped(service: string): KeychainStore;
  /** Ends the keychain's helper (the daemon stopping): its D-Bus connection closes. */
  close(): void;
}

/** One connection to the keychain: what the store asks of it. */
export interface KeychainClient {
  get(service: string, name: string): Promise<string | undefined>;
  set(service: string, name: string, value: string): Promise<void>;
  delete(service: string, name: string): Promise<boolean>;
  /** The accounts (entry names) kept under a service. */
  find(service: string): Promise<string[]>;
  /** Ends the connection: called when it is dropped, so none is left open (ADR-070). */
  close?(): void;
}

/**
 * The Secret Service over D-Bus, through the native keyring, pinned to
 * Secret Service (the library's default would silently fall back to the
 * kernel keyring, which forgets everything at reboot). Its calls run in a
 * helper process with a deadline, never on the daemon's thread pool
 * (ADR-070): a call that waits on a locked or absent keychain is killed
 * with its helper, and its D-Bus connection closes with it.
 */
export function secretServiceClient(): KeychainClient {
  return new HelperClient();
}

/**
 * A failure of the connection to the keychain, not of the keychain: the
 * desktop session's D-Bus closed or restarted under the daemon (2026-10-13:
 * "Platform failure: DBus error: Connection is closed").
 */
export function deadConnection(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error);
  return /D-?Bus error|Connection is closed|disconnected|Failed to read\/write data|No DBus session|keychain helper stopped/i.test(
    m,
  );
}

/**
 * No call was made: the Secret Service isn't up yet, or its collection is
 * locked (ADR-070), or this machine has no desktop session at all (`headless`).
 */
export class KeychainWaiting extends Error {
  constructor(
    readonly state: SecretServiceState,
    message: string,
  ) {
    super(message);
    this.name = "KeychainWaiting";
  }
  get headless() {
    return this.state === "no-bus";
  }
}

const WAITING: Partial<Record<SecretServiceState, string>> = {
  "no-bus": "This machine has no desktop session bus (headless), so no desktop keychain.",
  absent:
    "Waiting for the desktop keychain: the Secret Service isn't running yet (it starts with the desktop session).",
  locked:
    "Waiting for the keychain to unlock: the desktop keychain is locked (it unlocks when you log in to the desktop).",
};

/** How long what the bus said is trusted: an unlocked keychain longer than one not there yet. */
const GATE_TTL_MS = { unlocked: 30_000, other: 2000 };

/** The longest pause between two tries while the keychain's D-Bus is down. */
const MAX_BACKOFF_MS = 60_000;

/**
 * The connection the stores of one keychain share: dropped when it dies,
 * made again on the next use, with a growing pause while D-Bus stays down
 * (a call then fails at once, saying so, instead of waiting on a dead bus).
 */
export class KeychainLink {
  #client: KeychainClient | null = null;
  #failures = 0;
  #downUntil = 0;
  #lastError = "";
  readonly #gate: Gate;
  #gated: { state: SecretServiceState; at: number } | null = null;

  constructor(
    private readonly connect: () => KeychainClient = secretServiceClient,
    private readonly o: {
      now?: () => number;
      pauseMs?: number;
      /**
       * What the bus says before any call (ADR-070): asked of the session
       * bus for the real keychain; a stand-in client is called as it is.
       */
      gate?: Gate;
    } = {},
  ) {
    this.#gate =
      o.gate ??
      (connect === secretServiceClient ? secretServiceGate() : async () => "unknown" as const);
  }

  /**
   * Whether a call may be made: never one that would start the Secret
   * Service or prompt to unlock it. Throws KeychainWaiting otherwise.
   */
  async #passGate() {
    const now = this.#now();
    const g = this.#gated;
    const fresh =
      g && now - g.at < (g.state === "unlocked" ? GATE_TTL_MS.unlocked : GATE_TTL_MS.other);
    const state = fresh ? g.state : await this.#gate();
    if (!fresh) this.#gated = { state, at: now };
    const waiting = WAITING[state];
    if (waiting) throw new KeychainWaiting(state, waiting);
  }

  #now() {
    return (this.o.now ?? Date.now)();
  }

  /** Drops the connection, closing it (ADR-070: none is left open). */
  #drop() {
    const c = this.#client;
    this.#client = null;
    c?.close?.();
  }

  /** Ends the connection in use; the next call makes a new one. */
  close() {
    this.#drop();
  }

  /** D-Bus failed and the pause before the next try isn't over: when it is, else null. */
  downUntil(): number | null {
    return this.#downUntil > this.#now() ? this.#downUntil : null;
  }

  /**
   * One call on the keychain. A dead connection is dropped and the call
   * made once more on a new one (`retry`: reads and writes that may be
   * repeated); failing again, the next tries wait a growing pause.
   */
  async run<T>(call: (c: KeychainClient) => Promise<T>, retry = true): Promise<T> {
    if (this.downUntil())
      throw new Error(
        `The desktop keychain isn't answering (${this.#lastError}); trying again shortly.`,
      );
    await this.#passGate();
    for (let attempt = 0; ; attempt++) {
      // A connection made for this call: its failing is D-Bus down, not one gone stale.
      const fresh = !this.#client;
      this.#client ??= this.connect();
      try {
        const value = await call(this.#client);
        this.#failures = 0;
        this.#downUntil = 0;
        return value;
      } catch (error) {
        // A keychain that didn't answer is down like a dead bus, but not asked again at once.
        const timedOut = error instanceof KeychainTimeout;
        if (!timedOut && !deadConnection(error)) throw error;
        this.#drop();
        // The bus is asked again before the next call.
        this.#gated = null;
        this.#lastError = error instanceof Error ? error.message : String(error);
        if (!timedOut && retry && attempt === 0) {
          // A moment for the bus to come back, then a new connection.
          await new Promise((r) => setTimeout(r, this.o.pauseMs ?? 250));
          continue;
        }
        // Calls failing side by side are one outage: the pause grows once for them.
        if ((fresh || timedOut) && !this.downUntil())
          this.#downUntil = this.#now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#failures++);
        throw error;
      }
    }
  }
}

/**
 * Secrets in the desktop keychain through the Secret Service (GNOME
 * Keyring, KWallet, KeePassXC), over a connection that is made again when
 * D-Bus drops it.
 */
export function createKeychainStore(
  service = KEYCHAIN_SERVICE,
  link: KeychainLink = new KeychainLink(),
): KeychainStore {
  let status: SecretStoreStatus = {
    kind: "keychain",
    available: false,
    detail: "The keychain has not been checked yet.",
  };

  return {
    service,
    async probe() {
      try {
        await link.run((c) => c.get(service, "__probe__"));
        status = {
          kind: "keychain",
          available: true,
          detail: "Secrets are kept in the desktop keychain.",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = {
          kind: "keychain",
          available: false,
          detail:
            error instanceof KeychainWaiting
              ? message
              : `The desktop keychain (Secret Service) is not reachable: ${message}`,
        };
        // Headless: no keychain will come. Anything else may yet answer.
        return { ...status, waiting: !(error instanceof KeychainWaiting && error.headless) };
      }
      return status;
    },
    status: () => status,
    async names() {
      // Found by the exact service attribute: `oraknid` never matches `oraknid:<id>`.
      const found = await link.run((c) => c.find(service));
      return [...new Set(found)].filter((n) => n !== "__probe__");
    },
    scoped(other) {
      return createKeychainStore(other, link);
    },
    close() {
      link.close();
    },
    get(name) {
      return link.run((c) => c.get(service, name));
    },
    set(name, value) {
      return link.run((c) => c.set(service, name, value));
    },
    delete(name) {
      // Not repeated: a delete that went through would answer "nothing to delete" the second time.
      return link.run((c) => c.delete(service, name), false);
    },
  };
}
