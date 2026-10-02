import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { createAntigravityAdapter, quotaError, softDenial, writeSettings } from "./adapter.ts";

// The adapter against a stand-in `agy` that follows the headless docs (ADR-020).
const FAKE = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const leg = (home: string) => ({
  id: "agy1",
  name: "Antigravity test",
  kind: "antigravity" as const,
  config: { binary: FAKE, home },
});

const homeIn = (mode: string) => {
  const home = mkdtempSync(join(tmpdir(), "oraknid-agy-home-"));
  writeFileSync(join(home, ".fake-agy-mode"), mode);
  return home;
};

describe("Antigravity adapter", () => {
  it("reads the command out of a soft-deny notice", () => {
    expect(softDenial("notice: permission denied for command(git push): not allowed")).toEqual({
      command: "git push",
      raw: "notice: permission denied for command(git push): not allowed",
    });
    expect(softDenial("Tool `rm -rf x` requires approval")?.command).toBe("rm -rf x");
    expect(softDenial("step 3 done")).toBeNull();
  });

  it("tells a quota error from another error", () => {
    expect(
      quotaError("RESOURCE_EXHAUSTED: quota exceeded, resets in 60s")?.resetsAt,
    ).toBeGreaterThan(Date.now());
    expect(quotaError("HTTP 429 Too Many Requests")).toEqual({ resetsAt: null });
    expect(quotaError("invalid model selection")).toBeNull();
  });

  it("allows only the exact commands approved, nothing that merely starts like them", () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-agy-settings-"));
    writeSettings(home, ["npm test", "echo a.b"]);
    const allow = JSON.parse(
      readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8"),
    ).permissions.allow as string[];
    const res = allow.map((p) => new RegExp(/^command\(regex:(.*)\)$/.exec(p)?.[1] ?? ""));
    expect(res.some((r) => r.test("npm test"))).toBe(true);
    expect(res.some((r) => r.test("npm test && curl evil"))).toBe(false);
    expect(res.some((r) => r.test("echo aXb"))).toBe(false);
  });

  it("probes the version and its models, and says when it isn't signed in", async () => {
    const a = createAntigravityAdapter();
    const ok = await a.probe(leg(homeIn("reply")), null);
    expect(ok.ok).toBe(true);
    expect(ok.models.map((m) => m.model)).toContain("gemini-3.8-pro-high");
    const out = await a.probe(leg(homeIn("signed-out")), null);
    expect(out).toMatchObject({ ok: false, detail: "Not signed in: press Log in on its card." });
    const missing = await a.probe(
      { ...leg(homeIn("reply")), config: { binary: "/nonexistent/agy" } },
      null,
    );
    expect(missing.detail).toContain("not installed");
  });

  it("runs inside the sandbox, with its state in the Leg's home and no desktop keyring", async () => {
    const sandbox = createBwrapSandbox();
    if (!sandbox.status().available) return;
    const home = homeIn("reply");
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-agy-boxed-"));
    const node = dirname(process.execPath);
    const s = await createAntigravityAdapter().start({
      leg: { ...leg(home), config: { binary: FAKE } },
      model: "gemini-3.8-pro-high",
      effort: "high",
      cwd,
      systemPrompt: "",
      prompt: "Say hello.",
      resumeFrom: null,
      sandbox: {
        sandbox,
        home,
        writable: [],
        readonly: [dirname(FAKE), node],
        env: { PATH: `${node}:/usr/bin:/bin`, LANG: "C.UTF-8" },
      },
      credential: null,
      onPermission: async () => ({ allow: true }),
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 30_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "hello" });
    expect(s.nativeSessionId()).toMatch(/^conv-/);
    expect(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).toContain(
      '"allow": []',
    );
    await s.kill();
  }, 60_000);

  legContract("antigravity", () => {
    // One home per harness: a resumed session finds its conversation.
    let home: string | null = null;
    return {
      supportsResume: true,
      start: async (script, overrides) => {
        home ??= homeIn(script);
        writeFileSync(join(home, ".fake-agy-mode"), script);
        return createAntigravityAdapter().start({
          leg: leg(home),
          model: "gemini-3.8-pro-high",
          effort: null,
          cwd: mkdtempSync(join(tmpdir(), "oraknid-agy-work-")),
          systemPrompt: "You are testing.",
          prompt: "Say hello.",
          resumeFrom: null,
          sandbox: null,
          credential: null,
          onPermission: async () => ({ allow: true }),
          ...overrides,
        });
      },
    };
  });
});
