export interface SecretStoreStatus {
  kind: "keychain" | "encrypted-file" | "none";
  available: boolean;
  /** Plain words for the UI and `doctor` (BR-17). */
  detail: string;
}

/**
 * Where secrets live (BR-13). Secrets are referenced by name everywhere
 * else and resolved only when a process starts.
 */
export interface SecretStore {
  status(): SecretStoreStatus;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  /** The names of its entries, never their values (moving Oraknid, ADR-061). */
  names?(): Promise<string[]>;
}

export class SecretStoreUnavailable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SecretStoreUnavailable";
  }
}
