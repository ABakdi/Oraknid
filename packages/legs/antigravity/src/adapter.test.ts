import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import {
  createAntigravityAdapter,
  quotaError,
  refusals,
  writeMcpConfig,
  writeSettings,
} from "./adapter.ts";

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
  it("reads what agy refused from its events, not from its generic note", () => {
    let n = 0;
    const step = (state: string, CommandLine: string, extra: Record<string, unknown> = {}) => ({
      index: ++n,
      tool: "run_command",
      input: { CommandLine },
      state,
      output: null,
      error: null,
      ...extra,
    });
    const denied = [{ action: "command", display_name: "RunCommand" }];
    // Seen with agy 1.2.14: an ERROR step that says so, or a DONE step with no output.
    expect(
      refusals(
        [
          step("ERROR", "ls -la", {
            error: "permission check failed: user denied permission to run command:\nls -la",
          }),
          step("DONE", "cat b.txt"),
          step("DONE", "pwd", { output: "/w" }),
          step("DONE", "npm test"),
        ],
        [...denied, ...denied],
        new Set(["npm test"]),
      ).map((r) => r.command),
    ).toEqual(["ls -la", "cat b.txt"]);
    expect(refusals([step("DONE", "cat b.txt")], [], new Set())).toEqual([]);
    expect(refusals([], denied, new Set())).toEqual([
      { command: null, path: null, raw: "RunCommand was denied", index: null },
    ]);
    // A write refused in the sandbox: done, no output, and WriteToFile denied.
    const write = {
      index: 4,
      tool: "write_to_file",
      input: { TargetFile: "/w/b.txt" },
      state: "DONE",
      output: null,
      error: null,
    };
    expect(
      refusals([write], [{ action: "write_file", display_name: "WriteToFile" }], new Set()),
    ).toMatchObject([{ command: null, path: "/w/b.txt", index: 4 }]);
  });

  it("tells a quota error from another error", () => {
    expect(
      quotaError("RESOURCE_EXHAUSTED: quota exceeded, resets in 60s")?.resetsAt,
    ).toBeGreaterThan(Date.now());
    expect(quotaError("HTTP 429 Too Many Requests")).toEqual({ resetsAt: null });
    // The quota that sank a job on 2026-10-06: kept for its 51 hours, not 15 minutes (ADR-052).
    const at = Date.now();
    const r = quotaError(
      "Individual quota reached for Gemini 3 Pro. Resets in 51h49m11s.",
    )?.resetsAt;
    expect((r ?? 0) - at).toBeGreaterThanOrEqual((51 * 3600 + 49 * 60 + 11) * 1000 - 50);
    expect((r ?? 0) - at).toBeLessThan((51 * 3600 + 49 * 60 + 12) * 1000);
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

  it("counts a re-read conversation as cache, not as new work (seen with agy 1.2.14)", async () => {
    const s = await createAntigravityAdapter().start({
      leg: leg(homeIn("reply")),
      model: "gemini-3.8-flash-high",
      effort: null,
      cwd: mkdtempSync(join(tmpdir(), "oraknid-agy-usage-")),
      systemPrompt: "",
      prompt: "Say hello.",
      resumeFrom: null,
      sandbox: null,
      credential: null,
      onPermission: async () => ({ allow: true }),
    });
    await readUntil(s, (e) => e.type === "turn.ended");
    await s.send("again");
    await readUntil(s, (e) => e.type === "turn.ended");
    // The stand-in reports 10 input tokens a run: the same conversation, read twice.
    expect(s.usage()).toMatchObject({ inputTokens: 10, cacheReadTokens: 10 });
    await s.kill();
  });

  it("gives agy only Oraknid's bridges as MCP servers (ADR-021)", () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-agy-mcp-"));
    writeMcpConfig(home, { "oraknid-email": { command: "/usr/bin/node", args: ["/b.mjs", "/s"] } });
    expect(JSON.parse(readFileSync(join(home, ".gemini/config/mcp_config.json"), "utf8"))).toEqual({
      mcpServers: { "oraknid-email": { command: "/usr/bin/node", args: ["/b.mjs", "/s"] } },
    });
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
    expect(
      JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8"))
        .permissions.allow,
    ).toEqual([`write_file(${cwd}/)`]);
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
