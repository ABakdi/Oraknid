import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEncryptedFileStore,
  createKeychainStore,
  type KeychainStore,
  keychainService,
  type SecretStore,
  type SecretStoreStatus,
  SecretStoreUnavailable,
} from "@oraknid/os";

/**
 * This data folder's keychain id (Audit 2, S2-23): made once, kept in the
 * folder, so its keychain entries are its own. A copy of the folder keeps
 * the id, and shares the entries.
 */
export function keychainId(dataDir: string): string {
  const file = join(dataDir, "keychain-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{16,64}$/.test(id)) return id;
  } catch {}
  const id = randomBytes(8).toString("hex");
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

export interface SecretsOptions {
  /**
   * This is the default data folder: the keychain entries of before (one
   * service for every folder) are its own, and move under its id.
   */
  ownsLegacy?: boolean;
  /** Where to say how many entries moved (a count, never a value). */
  log?: (message: string) => void;
}

/**
 * The secret store in use (BR-13): the desktop keychain when it answers,
 * otherwise an encrypted file that stays locked until I give the
 * passphrase (Security spec). In the keychain, each data folder has a
 * service of its own, `oraknid:<id>` (Audit 2, S2-23).
 */
export class Secrets {
  #store: SecretStore | undefined;
  #status: SecretStoreStatus = { kind: "none", available: false, detail: "Not checked yet." };
  readonly #file: string;
  readonly #dataDir: string;
  readonly #known = new Set<string>();
  /** The keychain entries of before, while some may be left (the default data folder only). */
  #legacy: KeychainStore | undefined;

  constructor(
    dataDir: string,
    private readonly keychain: KeychainStore = createKeychainStore(),
    private readonly options: SecretsOptions = {},
  ) {
    this.#dataDir = dataDir;
    this.#file = join(dataDir, "secrets.json");
  }

  async init(): Promise<SecretStoreStatus> {
    const probe = await this.keychain.probe();
    if (probe.available) {
      const mine = this.keychain.scoped(keychainService(keychainId(this.#dataDir)));
      this.#store = mine;
      this.#status = probe;
      if (this.options.ownsLegacy) {
        this.#legacy = this.keychain;
        await this.#migrate(mine);
      }
    } else {
      this.#status = {
        kind: "none",
        available: false,
        detail: `${probe.detail} Secrets fall back to an encrypted file, locked until the passphrase is entered.`,
      };
    }
    return this.#status;
  }

  /**
   * Moves the entries of before under this folder's service: each one
   * copied where there is none yet, read back, then removed from the old
   * service. One that can't be moved stays, and `get` still finds it.
   */
  async #migrate(to: SecretStore): Promise<void> {
    const legacy = this.#legacy;
    if (!legacy) return;
    let names: string[];
    try {
      names = await legacy.names();
    } catch (error) {
      this.options.log?.(
        `Keychain: the entries of before could not be listed (${(error as Error).message}); each one moves when it is next read.`,
      );
      return;
    }
    let moved = 0;
    for (const name of names) if ((await this.#move(name, to)) !== undefined) moved++;
    if (moved)
      this.options.log?.(`Keychain: ${moved} entries moved under this data folder's own name.`);
  }

  /** One entry of before, moved; its value now, or undefined when there was none. */
  async #move(name: string, to: SecretStore): Promise<string | undefined> {
    const legacy = this.#legacy;
    if (!legacy) return undefined;
    try {
      const old = await legacy.get(name);
      if (old === undefined) return undefined;
      const mine = await to.get(name);
      // One already under the new service was written since, and wins.
      if (mine === undefined) await to.set(name, old);
      const kept = mine ?? (await to.get(name));
      if (kept === undefined) return undefined;
      await legacy.delete(name);
      return kept;
    } catch {
      return undefined;
    }
  }

  /** Opens (or creates) the encrypted file. Throws SecretStoreUnavailable on a wrong passphrase. */
  unlock(passphrase: string): SecretStoreStatus {
    if (this.#store && this.#status.kind === "keychain") return this.#status;
    if (passphrase.length < 8)
      throw new SecretStoreUnavailable("Use a passphrase of at least 8 characters.");
    this.#store = createEncryptedFileStore(this.#file, passphrase);
    this.#status = this.#store.status();
    return this.#status;
  }

  status(): SecretStoreStatus {
    return this.#status;
  }

  async get(name: string): Promise<string | undefined> {
    let v = await this.#store?.get(name);
    if (v === undefined && this.#legacy && this.#store) v = await this.#move(name, this.#store);
    if (v) this.#known.add(v);
    return v;
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.#store) throw new SecretStoreUnavailable(this.#status.detail);
    await this.#store.set(name, value);
    this.#known.add(value);
    // An old entry of the same name would come back through `get` once this one is deleted.
    if (this.#legacy) await this.#legacy.delete(name).catch(() => false);
  }

  /** Values handled since start, so logs and events can be scrubbed of them (BR-13). */
  known(): Iterable<string> {
    return this.#known;
  }

  async delete(name: string): Promise<boolean> {
    if (!this.#store) return false;
    const gone = await this.#store.delete(name);
    const old = this.#legacy ? await this.#legacy.delete(name).catch(() => false) : false;
    return gone || old;
  }
}
