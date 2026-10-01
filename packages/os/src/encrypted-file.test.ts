import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEncryptedFileStore } from "./encrypted-file.ts";
import { SecretStoreUnavailable } from "./secrets.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "oraknid-secrets-")), "secrets.json");

describe("encrypted file store", () => {
  it("stores, reads back and deletes a secret", async () => {
    const s = createEncryptedFileStore(file(), "correct horse");
    await s.set("smtp", "hunter2");
    expect(await s.get("smtp")).toBe("hunter2");
    expect(await s.delete("smtp")).toBe(true);
    expect(await s.get("smtp")).toBeUndefined();
    expect(await s.delete("smtp")).toBe(false);
  });

  it("keeps secrets across restarts with the same passphrase", async () => {
    const f = file();
    await createEncryptedFileStore(f, "correct horse").set("vapid", "k3y");
    expect(await createEncryptedFileStore(f, "correct horse").get("vapid")).toBe("k3y");
  });

  it("refuses the wrong passphrase with a clear message", async () => {
    const f = file();
    await createEncryptedFileStore(f, "correct horse").set("vapid", "k3y");
    expect(() => createEncryptedFileStore(f, "wrong")).toThrow(SecretStoreUnavailable);
    expect(() => createEncryptedFileStore(f, "wrong")).toThrow(/passphrase/);
  });

  it("never writes a secret in plain text, and only I can read the file", async () => {
    const f = file();
    await createEncryptedFileStore(f, "correct horse").set("token", "PLAINTEXT-MARKER");
    expect(readFileSync(f, "utf8")).not.toContain("PLAINTEXT-MARKER");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
