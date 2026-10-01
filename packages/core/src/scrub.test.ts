import { describe, expect, it } from "vitest";
import { scrubSecrets } from "./scrub.ts";

describe("scrubSecrets (BR-13)", () => {
  it("hides known values and secret-shaped strings, and leaves the rest", () => {
    const text =
      "smtp pass hunter2-long, key sk-abcdefghijklmnop1234, Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345, ghp_abcdefghijklmnopqrstuvwxyz, ok";
    expect(scrubSecrets(text, ["hunter2-long"])).toBe(
      "smtp pass [secret], key [secret], Authorization: Bearer [secret], [secret], ok",
    );
  });

  it("removes a whole private key block", () => {
    expect(
      scrubSecrets(
        "a -----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY----- b",
      ),
    ).toBe("a [secret] b");
  });

  it("ignores values too short to be secrets, so it never blanks ordinary words", () => {
    expect(scrubSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });

  it("covers more token shapes (Audit 1 → S1-13)", () => {
    const text = [
      `sk_${"live"}_${"a".repeat(24)}`,
      `npm_${"b".repeat(36)}`,
      `glpat-${"c".repeat(20)}`,
      `hf_${"d".repeat(34)}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "https://me:hunter2pass@example.com/repo.git",
    ].join(" ");
    expect(scrubSecrets(text)).toBe(
      "[secret] [secret] [secret] [secret] [secret] https://me:[secret]@example.com/repo.git",
    );
  });
});
