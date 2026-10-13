import { AsyncEntry, findCredentialsAsync } from "@napi-rs/keyring";
import type { SecretStore, SecretStoreStatus } from "../secrets.ts";

/** The service the entries of before were kept under, one for every data folder (Audit 2, S2-23). */
export const KEYCHAIN_SERVICE = "oraknid";

/** The service of one data folder's entries: `oraknid:<its keychain id>`. */
export function keychainService(id: string): string {
  return `${KEYCHAIN_SERVICE}:${id}`;
}

/** A keychain store over one service, which can name others of the same keychain. */
export interface KeychainStore extends SecretStore {
  probe(): Promise<SecretStoreStatus>;
  /** The service its entries are kept under. */
  readonly service: string;
  /** The names of this service's entries (never their values). */
  names(): Promise<string[]>;
  /** The same keychain, another service: one data folder's entries (S2-23). */
  scoped(service: string): KeychainStore;
}

/** One connection to the keychain: what the store asks of it. */
export interface KeychainClient {
  get(service: string, name: string): Promise<string | undefined>;
  set(service: string, name: string, value: string): Promise<void>;
  delete(service: string, name: string): Promise<boolean>;
  /** The accounts (entry names) kept under a service. */
  find(service: string): Promise<string[]>;
}

/**
 * The Secret Service over D-Bus, through the native keyring. Pinned to
 * Secret Service: the library's default would silently fall back to the
 * kernel keyring, which forgets everything at reboot. The native side
 * opens its D-Bus connection for each call (seen on a private bus
 * restarted under a running process, 2026-10-13), so a client made again
 * is a connection made again.
 */
export function secretServiceClient(): KeychainClient {
  const entry = (service: string, name: string) =>
    new AsyncEntry(service, name, { linux: { store: "secret-service" } });
  return {
    async get(service, name) {
      return (await entry(service, name).getPassword()) ?? undefined;
    },
    async set(service, name, value) {
      await entry(service, name).setPassword(value);
    },
    delete(service, name) {
      return entry(service, name).deleteCredential();
    },
    async find(service) {
      return (await findCredentialsAsync(service)).map((c) => c.account);
    },
  };
}

/**
 * A failure of the connection to the keychain, not of the keychain: the
 * desktop session's D-Bus closed or restarted under the daemon (2026-10-13:
 * "Platform failure: DBus error: Connection is closed").
 */
export function deadConnection(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error);
  return /D-?Bus error|Connection is closed|disconnected|Failed to read\/write data|No DBus session/i.test(
    m,
  );
}

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

  constructor(
    private readonly connect: () => KeychainClient = secretServiceClient,
    private readonly o: { now?: () => number; pauseMs?: number } = {},
  ) {}

  #now() {
    return (this.o.now ?? Date.now)();
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
        `The desktop keychain's D-Bus connection is down (${this.#lastError}); trying again shortly.`,
      );
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
        if (!deadConnection(error)) throw error;
        this.#client = null;
        this.#lastError = error instanceof Error ? error.message : String(error);
        if (retry && attempt === 0) {
          // A moment for the bus to come back, then a new connection.
          await new Promise((r) => setTimeout(r, this.o.pauseMs ?? 250));
          continue;
        }
        // Calls failing side by side are one outage: the pause grows once for them.
        if (fresh && !this.downUntil())
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
        status = {
          kind: "keychain",
          available: false,
          detail: `The desktop keychain (Secret Service) is not reachable: ${(error as Error).message}`,
        };
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
