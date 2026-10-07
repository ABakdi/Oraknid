import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type SecretStore, type SecretStoreStatus, SecretStoreUnavailable } from "./secrets.ts";

interface FileFormat {
  version: 1;
  /** scrypt salt, base64. */
  salt: string;
  /** Proves the passphrase without decrypting a secret. */
  check: Sealed;
  entries: Record<string, Sealed>;
}

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

const CHECK = "oraknid";

/**
 * The fallback when no keychain is available: AES-256-GCM with a key
 * derived from a passphrase I enter (scrypt), in a 0600 file.
 */
export function createEncryptedFileStore(file: string, passphrase: string): SecretStore {
  let contents = load();
  const key = scryptSync(passphrase, Buffer.from(contents.salt, "base64"), 32);

  if (contents.check.data === "") {
    contents.check = seal(key, CHECK);
    save();
  } else if (open(key, contents.check) !== CHECK) {
    throw new SecretStoreUnavailable(
      "The passphrase does not open the secrets file. Enter the passphrase it was created with.",
    );
  }

  function load(): FileFormat {
    if (!existsSync(file)) {
      return {
        version: 1,
        salt: randomBytes(16).toString("base64"),
        check: { iv: "", tag: "", data: "" },
        entries: {},
      };
    }
    return JSON.parse(readFileSync(file, "utf8")) as FileFormat;
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  const status: SecretStoreStatus = {
    kind: "encrypted-file",
    available: true,
    detail: `Secrets are kept in an encrypted file (${file}) because no keychain is available.`,
  };

  return {
    status: () => status,
    async get(name) {
      const sealed = contents.entries[name];
      return sealed ? open(key, sealed) : undefined;
    },
    async set(name, value) {
      contents = { ...contents, entries: { ...contents.entries, [name]: seal(key, value) } };
      save();
    },
    async names() {
      return Object.keys(contents.entries);
    },
    async delete(name) {
      if (!(name in contents.entries)) return false;
      const { [name]: _gone, ...rest } = contents.entries;
      contents = { ...contents, entries: rest };
      save();
      return true;
    },
  };
}

function seal(key: Buffer, plain: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function open(key: Buffer, sealed: Sealed): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}
