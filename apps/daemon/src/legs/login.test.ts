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
import { FAKE_CODEX } from "@oraknid/leg-codex/fake";
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
if [ "$code" = theme ]; then
  # A first sign-in goes on to a theme picker whose preview shows sample errors (2026-10-08).
  printf '? Choose a theme\n │ ✗ error: compilation failed │\n │ · dim: press Enter to continue │\n'
  read -r pick
fi
if [ "$code" = bad ]; then echo "Error: invalid authorization code"; sleep 30; exit 1; fi
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

  it("answers agy's first-run theme picker and isn't fooled by the sample error in it", async () => {
    const { l, leg, token } = setup();
    signedInBefore(token);
    await l.start(leg);
    const r = await l.finish(leg, "theme");
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(token, "utf8").trim()).toBe("new-theme");
    expect(existsSync(`${token}.before-sign-in`)).toBe(false);
  });

  it("says agy's own failure briefly, and keeps the earlier sign-in", async () => {
    const { l, leg, token } = setup();
    signedInBefore(token);
    await l.start(leg);
    const r = await l.finish(leg, "bad");
    expect(r).toEqual({ ok: false, detail: "Error: invalid authorization code" });
    expect(readFileSync(token, "utf8")).toBe("old");
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

// Signing a Codex Leg in (ADR-057), against the stand-in codex: a link and a
// one-time code, finished on OpenAI's side, the login in the Leg's own CODEX_HOME.
describe("signing Codex in", { timeout: 60_000 }, () => {
  const codexSetup = (mode: string) => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-login-codex-"));
    const legs = join(dir, "legs");
    const codexHome = join(legs, "C1", "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, ".fake-codex-mode"), mode);
    const leg = { id: "C1", kind: "codex", config: { binary: FAKE_CODEX } } as unknown as LegRow;
    const l = new LegLogins(legs, null, 2_000);
    logins.push(l);
    return { l, leg, codexHome };
  };

  it("shows the link and the code, and is signed in once the code was entered there", async () => {
    const { l, leg, codexHome } = codexSetup("reply");
    expect(l.status(leg)).toEqual({ loggedIn: false, detail: "Not logged in." });
    const started = await l.start(leg);
    expect(started).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    });
    // Not entered yet: it keeps waiting, and says so.
    const early = await l.finish(leg, "done");
    expect(early.ok).toBe(false);
    expect(early.detail).toContain("still waiting");
    writeFileSync(join(codexHome, ".fake-approved"), "");
    const r = await l.finish(leg, "done");
    expect(r).toEqual({ ok: true, detail: "Logged in using ChatGPT." });
    // The login is the Leg's, in a file, never my ~/.codex.
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
  });

  it("falls back to the browser sign-in where device codes are off", async () => {
    const { l, leg } = codexSetup("no-device");
    const started = await l.start(leg);
    expect(started.url).toContain("https://auth.openai.com/oauth/authorize");
    expect(started.userCode).toBeUndefined();
    expect(started.note).toContain("localhost:1455");
  });

  it("has nothing to log in with an API key", async () => {
    const { l, leg } = codexSetup("reply");
    await expect(
      l.start({ ...leg, config: { ...leg.config, auth: "api-key" } } as LegRow),
    ).rejects.toThrow(/API key/);
  });
});
