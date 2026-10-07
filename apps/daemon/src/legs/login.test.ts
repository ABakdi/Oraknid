import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegLogins } from "./login.ts";
import type { LegRow } from "./registry.ts";

// Signing an Antigravity Leg in from the web UI (BR-22, ADR-020), against a
// stand-in agy: signed in, it opens on its prompt and shows no link.

const AGY = `#!/bin/sh
token="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
if [ "$1" = models ]; then
  [ -f "$token" ] && { echo gemini-flash; exit 0; }
  echo "authentication required"; exit 1
fi
if [ -f "$token" ]; then echo "agy > "; sleep 30; exit 0; fi
printf 'Select login method:\\n > 1. Google OAuth\\n'
read -r choice
echo "Open https://accounts.google.com/o/oauth2/auth?state=xyz and paste the code:"
read -r code
mkdir -p "$(dirname "$token")"
echo "new-$code" > "$token"
echo "agy > "
sleep 30
`;

const dirs: string[] = [];
const logins: LegLogins[] = [];
afterEach(() => {
  for (const l of logins.splice(0)) l.stopAll();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-login-"));
  dirs.push(dir);
  const agy = join(dir, "agy");
  writeFileSync(agy, AGY);
  chmodSync(agy, 0o755);
  const legs = join(dir, "legs");
  const leg = { id: "L1", kind: "antigravity", config: { binary: agy } } as unknown as LegRow;
  const token = join(legs, "L1", "home", ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const l = new LegLogins(legs, null);
  logins.push(l);
  return { l, leg, token };
}

function signedInBefore(token: string) {
  mkdirSync(join(token, ".."), { recursive: true });
  writeFileSync(token, "old");
}

describe("signing Antigravity in again", { timeout: 60_000 }, () => {
  it("shows the link though the Leg is signed in already, and keeps the new sign-in", async () => {
    const { l, leg, token } = setup();
    signedInBefore(token);
    const { url } = await l.start(leg);
    expect(url).toContain("accounts.google.com");
    const r = await l.finish(leg, "c0de");
    expect(r.ok).toBe(true);
    expect(readFileSync(token, "utf8").trim()).toBe("new-c0de");
    expect(existsSync(`${token}.before-sign-in`)).toBe(false);
  });

  it("gives the earlier sign-in back when this one doesn't finish", async () => {
    const { l, leg, token } = setup();
    signedInBefore(token);
    await l.start(leg);
    expect(existsSync(token)).toBe(false);
    l.cancel(leg.id);
    expect(readFileSync(token, "utf8")).toBe("old");
    expect(existsSync(`${token}.before-sign-in`)).toBe(false);
  });
});
