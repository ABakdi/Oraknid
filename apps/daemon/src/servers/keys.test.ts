import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";
import { newKeyPair } from "./ssh.ts";

describe("the keys Oraknid makes for servers (ADR-026)", () => {
  it("can always be read back: ssh2 writes about one ed25519 key in two hundred malformed", () => {
    for (let i = 0; i < 2000; i++) {
      const k = newKeyPair("oraknid-test");
      expect(ssh2.utils.parseKey(k.privateKey)).not.toBeInstanceOf(Error);
      expect(ssh2.utils.parseKey(k.publicKey)).not.toBeInstanceOf(Error);
    }
  });
});
