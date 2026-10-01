import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStore, SecretStoreStatus } from "../secrets.ts";

const SERVICE = "oraknid";

/**
 * Secrets in the desktop keychain through the Secret Service (GNOME
 * Keyring, KWallet, KeePassXC). Pinned to Secret Service: the library's
 * default would silently fall back to the kernel keyring, which forgets
 * everything at reboot.
 */
export function createKeychainStore(): SecretStore & { probe(): Promise<SecretStoreStatus> } {
  let status: SecretStoreStatus = {
    kind: "keychain",
    available: false,
    detail: "The keychain has not been checked yet.",
  };
  const entry = (name: string) =>
    new AsyncEntry(SERVICE, name, { linux: { store: "secret-service" } });

  return {
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
