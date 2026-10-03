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

/**
 * Secrets in the desktop keychain through the Secret Service (GNOME
 * Keyring, KWallet, KeePassXC). Pinned to Secret Service: the library's
 * default would silently fall back to the kernel keyring, which forgets
 * everything at reboot.
 */
export function createKeychainStore(service = KEYCHAIN_SERVICE): KeychainStore {
  let status: SecretStoreStatus = {
    kind: "keychain",
    available: false,
    detail: "The keychain has not been checked yet.",
  };
  const entry = (name: string) =>
    new AsyncEntry(service, name, { linux: { store: "secret-service" } });

  return {
    service,
    async probe() {
      try {
        await entry("__probe__").getPassword();
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
      const found = await findCredentialsAsync(service);
      return [...new Set(found.map((c) => c.account))].filter((n) => n !== "__probe__");
    },
    scoped(other) {
      return createKeychainStore(other);
    },
    async get(name) {
      return (await entry(name).getPassword()) ?? undefined;
    },
    async set(name, value) {
      await entry(name).setPassword(value);
    },
    async delete(name) {
      return entry(name).deleteCredential();
    },
  };
}
