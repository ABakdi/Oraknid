import { join } from "node:path";
import {
  createEncryptedFileStore,
  createKeychainStore,
  type SecretStore,
  type SecretStoreStatus,
  SecretStoreUnavailable,
} from "@oraknid/os";

/**
 * The secret store in use (BR-13): the desktop keychain when it answers,
 * otherwise an encrypted file that stays locked until I give the
 * passphrase (Security spec).
 */
export class Secrets {
  #store: SecretStore | undefined;
  #status: SecretStoreStatus = { kind: "none", available: false, detail: "Not checked yet." };
  readonly #file: string;

  constructor(
    dataDir: string,
    private readonly keychain = createKeychainStore(),
  ) {
    this.#file = join(dataDir, "secrets.json");
  }

  async init(): Promise<SecretStoreStatus> {
    const probe = await this.keychain.probe();
    if (probe.available) {
      this.#store = this.keychain;
      this.#status = probe;
    } else {
      this.#status = {
        kind: "none",
        available: false,
        detail: `${probe.detail} Secrets fall back to an encrypted file, locked until the passphrase is entered.`,
      };
    }
    return this.#status;
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
    return this.#store?.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.#store) throw new SecretStoreUnavailable(this.#status.detail);
    await this.#store.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    return this.#store ? this.#store.delete(name) : false;
  }
}
