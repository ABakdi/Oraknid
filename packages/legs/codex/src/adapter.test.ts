import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionStart } from "@oraknid/leg-sdk";
import { legContract, permissionRecorder, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { BASE_CONFIG, createCodexAdapter, runArgs } from "./adapter.ts";
import { FAKE_CODEX } from "./fake.ts";
import {
  commandText,
  modelsFromCatalog,
  patchFiles,
  planFromRateLimits,
  requestsOf,
  resultOf,
  usageLimit,
  windowName,
} from "./parse.ts";

// The adapter against a stand-in `codex` that follows codex-cli 0.161.0 (ADR-057).
chmodSync(FAKE_CODEX, 0o755);

const codexHomeIn = (mode: string) => {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-codex-home-"));
  writeFileSync(join(dir, ".fake-codex-mode"), mode);
  return dir;
};

const leg = (codexHome: string, extra: Record<string, unknown> = {}) => ({
  id: "cx1",
  name: "Codex test",
  kind: "codex" as const,
  config: { binary: FAKE_CODEX, codexHome, ...extra },
});

const start = (codexHome: string, o: Partial<SessionStart> = {}) =>
  createCodexAdapter().start({
    leg: leg(codexHome),
    model: "gpt-6-sol",
    effort: null,
    cwd: mkdtempSync(join(tmpdir(), "oraknid-codex-work-")),
    systemPrompt: "You are testing.",
    prompt: "Say hello.",
    resumeFrom: null,
    sandbox: null,
    credential: null,
    onPermission: async () => ({ allow: true }),
    ...o,
  });

const lastArgs = (codexHome: string) =>
  JSON.parse(readFileSync(join(codexHome, ".fake-codex-args.json"), "utf8")) as string[];

describe("Codex: reading what it says", () => {
  it("reads a usage limit and when it lifts, from Codex's own wording", () => {
    const now = new Date(2026, 9, 7, 14, 0);
    // Today, later: that time today.
    expect(
      usageLimit(
        "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.",
        now,
      )?.resetsAt,
    ).toBe(new Date(2026, 9, 7, 15, 45).getTime());
    // A time already past today is tomorrow's.
    expect(usageLimit("You've hit your usage limit. Try again at 9:05 AM.", now)?.resetsAt).toBe(
      new Date(2026, 9, 8, 9, 5).getTime(),
    );
    // Another day: with its date.
    expect(
      usageLimit("You've hit your usage limit. Try again at Oct 9th, 2026 12:30 AM.", now)
        ?.resetsAt,
    ).toBe(new Date(2026, 9, 9, 0, 30).getTime());
    expect(usageLimit("You've hit your usage limit. Try again later.", now)).toEqual({
      resetsAt: null,
    });
    expect(usageLimit("Rate limit reached; try again in 2h 5m.", now)?.resetsAt).toBe(
      now.getTime() + (2 * 60 + 5) * 60_000,
    );
    expect(usageLimit("Quota exceeded. Check your plan and billing details.", now)).toEqual({
      resetsAt: null,
    });
    expect(usageLimit("Selected model is at capacity. Please try a different model.", now)).toBe(
      null,
    );
    expect(usageLimit("stream disconnected before completion", now)).toBeNull();
  });

  it("asks the policy about commands, each file of a patch and MCP calls, not Codex's own bookkeeping", () => {
    expect(requestsOf("Bash", { command: "npm test" })).toEqual([
      { tool: "Bash", input: { command: "npm test" }, command: "npm test", path: null },
    ]);
    expect(requestsOf("shell", { command: ["bash", "-lc", "ls -la"] })[0]?.command).toBe("ls -la");
    const patch =
      "*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.ts\n*** Move to: src/c.ts\n@@\n-y\n+z\n*** Delete File: old.md\n*** End Patch";
    expect(patchFiles(patch).map((f) => f.path)).toEqual([
      "a.txt",
      "src/b.ts",
      "old.md",
      "src/c.ts",
    ]);
    expect(requestsOf("apply_patch", { command: patch }).map((r) => [r.tool, r.path])).toEqual([
      ["Write", "a.txt"],
      ["Edit", "src/b.ts"],
      ["Edit", "old.md"],
      ["Write", "src/c.ts"],
    ]);
    expect(requestsOf("mcp__oraknid-email__send", { to: "x" })).toEqual([
      { tool: "mcp__oraknid-email__send", input: { to: "x" }, command: null, path: null },
    ]);
    expect(requestsOf("update_plan", { plan: [] })).toEqual([]);
    expect(commandText(["git", "commit", "-m", "a b"])).toBe("git commit -m 'a b'");
  });

  it("reads tool items' results", () => {
    expect(
      resultOf({
        id: "i",
        type: "command_execution",
        command: "false",
        aggregated_output: "no",
        exit_code: 1,
        status: "failed",
      }),
    ).toEqual({ ok: false, output: "no\n(exit 1)" });
    expect(
      resultOf({
        id: "i",
        type: "mcp_tool_call",
        status: "completed",
        result: { content: [{ type: "text", text: "sent" }] },
        error: null,
      }),
    ).toEqual({ ok: true, output: "sent" });
  });

  it("offers the models Codex lists, with their reasoning levels and context", () => {
    const catalog = JSON.stringify({
      models: [
        {
          slug: "gpt-6-sol",
          display_name: "GPT-6-Sol",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          context_window: 272000,
        },
        {
          slug: "gpt-6-luna",
          display_name: "GPT-6-Luna",
          visibility: "list",
          supported_in_api: false,
        },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    });
    expect(modelsFromCatalog(catalog, false).map((m) => m.model)).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(modelsFromCatalog(catalog, false)[0]).toMatchObject({
      effortLevels: ["low", "high"],
      contextWindow: 272000,
    });
    // An API key: only what the API serves.
    expect(modelsFromCatalog(catalog, true).map((m) => m.model)).toEqual(["gpt-6-sol"]);
    expect(modelsFromCatalog("not json", false)).toEqual([]);
  });

  it("reads the plan's windows from the app server's answer", () => {
    expect(
      planFromRateLimits({
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: null },
        },
      }),
    ).toEqual({
      available: true,
      windows: [
        {
          window: "five_hour",
          scope: "account",
          label: null,
          utilization: 0.42,
          resetsAt: 1_800_000_000_000,
        },
        { window: "seven_day", scope: "account", label: null, utilization: 0.07, resetsAt: null },
      ],
    });
    expect(planFromRateLimits({})).toEqual({ available: false, windows: [] });
    expect(windowName(15)).toBe("15_minutes");
  });

  it("passes `exec resume` only flags it takes, and never Codex's sandbox or its prompts", () => {
    const args = runArgs({
      model: "gpt-6-sol",
      effort: "high",
      resume: "t-1",
      mcp: { "oraknid-email": { command: "/usr/bin/node", args: ["/b.mjs", "/s.sock"] } },
      hookCommand: "/usr/bin/node /h/hook.mjs /h/hook.sock",
      stopHook: true,
    });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-2)).toEqual(["t-1", "-"]);
    // `exec resume` has no --sandbox, --cd nor --profile (codex-cli 0.161.0).
    for (const flag of ["-s", "--sandbox", "-C", "-p", "--add-dir"])
      expect(args).not.toContain(flag);
    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain(
      'mcp_servers.oraknid-email={command="/usr/bin/node",args=["/b.mjs","/s.sock"],startup_timeout_sec=30,tool_timeout_sec=3600}',
    );
    expect(args.find((a) => a.startsWith("hooks.Stop="))).toBeTruthy();
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("Codex adapter", () => {
  it("probes its version, its login in the Leg's CODEX_HOME and its catalog", async () => {
    const a = createCodexAdapter();
    const home = codexHomeIn("reply");
    const out = await a.probe(leg(home), null);
    expect(out).toMatchObject({ ok: false, detail: "Not signed in: press Log in on its card." });
    writeFileSync(join(home, "auth.json"), "{}");
    const ok = await a.probe(leg(home), null);
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("0.161.0");
    expect(ok.models.map((m) => m.model)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(ok.features).toMatchObject({ resume: true, tools: true, quotaWindows: true });
    // Its settings, written for the Leg: the login in a file, no update check.
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(BASE_CONFIG);
    // An API key: no login asked for, only the API's models, no plan windows.
    const keyed = await a.probe(leg(codexHomeIn("reply"), { auth: "api-key" }), null);
    expect(keyed).toMatchObject({ ok: true, features: { quotaWindows: false } });
    expect(keyed.models.map((m) => m.model)).toEqual(["gpt-6-sol"]);
    const missing = await a.probe(leg(home, { binary: "/nonexistent/codex" }), null);
    expect(missing.detail).toContain("not installed");
  });

  it("reads the plan's windows without a prompt", async () => {
    const a = createCodexAdapter();
    const report = await a.planUsage?.(leg(codexHomeIn("reply")), null);
    expect(report?.windows.map((w) => [w.window, w.utilization])).toEqual([
      ["five_hour", 0.42],
      ["seven_day", 0.07],
    ]);
    expect(await a.planUsage?.(leg(codexHomeIn("reply"), { auth: "api-key" }), null)).toEqual({
      available: false,
      windows: [],
    });
  });

  it("counts a thread's running totals once, cached input apart", async () => {
    const home = codexHomeIn("reply");
    const s = await start(home);
    await readUntil(s, (e) => e.type === "turn.ended");
    await s.send("again");
    await readUntil(s, (e) => e.type === "turn.ended");
    // The stand-in adds 100 input (20 cached) and 10 output a turn, as running totals.
    expect(s.usage()).toMatchObject({ inputTokens: 160, cacheReadTokens: 40, outputTokens: 20 });
    // The second turn continued the thread.
    expect(lastArgs(home).slice(0, 2)).toEqual(["exec", "resume"]);
    await s.kill();
  });

  it("gives the first message the context pack, and Codex an API key only through its environment", async () => {
    const home = codexHomeIn("reply");
    const s = await start(home, { credential: "sk-test" });
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(events.some((e) => e.type === "thinking.delta")).toBe(true);
    const thread = s.nativeSessionId();
    const saved = JSON.parse(readFileSync(join(home, "sessions", `${thread}.json`), "utf8"));
    expect(saved.turns[0]).toBe("You are testing.\n\n---\n\nSay hello.");
    expect(lastArgs(home).join(" ")).not.toContain("sk-test");
    await s.kill();
  });

  it("asks before each file a patch writes, and reports the change", async () => {
    const rec = permissionRecorder({ allow: true });
    const s = await start(codexHomeIn("patch"), { onPermission: rec.onPermission });
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(rec.asked.map((r) => [r.tool, r.path])).toEqual([["Write", "notes.txt"]]);
    expect(events.find((e) => e.type === "tool.called")).toMatchObject({ tool: "Edit" });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ ok: true });
    await s.kill();
  });

  it("in auto mode, Oraknid's layer 1 refuses first, and what it allows needs no prompt", async () => {
    const rec = permissionRecorder({ allow: true });
    const denied = await start(codexHomeIn("tool"), {
      permissionMode: "auto",
      onPermission: rec.onPermission,
      onPreToolUse: async () => ({ decision: "deny", message: "Never here." }),
    });
    const a = await readUntil(denied, (e) => e.type === "turn.ended");
    expect(a.find((e) => e.type === "permission.denied")).toMatchObject({ by: "oraknid" });
    expect(a.filter((e) => e.type === "tool.result")).toEqual([
      expect.objectContaining({ ok: false, output: "Never here." }),
    ]);
    await denied.kill();
    const allowed = await start(codexHomeIn("tool"), {
      permissionMode: "auto",
      onPermission: rec.onPermission,
      onPreToolUse: async () => ({ decision: "allow", reason: "once" }),
    });
    const b = await readUntil(allowed, (e) => e.type === "turn.ended");
    expect(b.find((e) => e.type === "tool.result")).toMatchObject({ ok: true, output: "hi\n" });
    // Nothing left to layer 1 reached the prompt; "no opinion" would have.
    expect(rec.asked).toEqual([]);
    await allowed.kill();
  });

  it("stops the session when Codex runs a tool without asking Oraknid (its hooks not active)", async () => {
    const home = codexHomeIn("tool");
    writeFileSync(join(home, ".fake-codex-no-hooks"), "");
    const rec = permissionRecorder({ allow: true });
    const s = await start(home, { permissionMode: "auto", onPermission: rec.onPermission });
    const events = await readUntil(s, (e) => e.type === "session.ended");
    expect(events.find((e) => e.type === "permission.denied")).toMatchObject({ by: "oraknid" });
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      reason: "crashed",
      error: expect.stringContaining("without asking Oraknid"),
    });
    expect(events.some((e) => e.type === "tool.result" && e.ok)).toBe(false);
    await s.kill();
  });

  it("passes MCP calls to the policy by their tool name", async () => {
    const rec = permissionRecorder({ allow: true });
    const s = await start(codexHomeIn("mcp"), {
      onPermission: rec.onPermission,
      mcpServers: { "oraknid-email": { command: "/usr/bin/node", args: ["/b.mjs"] } },
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(rec.asked[0]?.tool).toBe("mcp__oraknid-email__send");
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({
      ok: true,
      output: "sent",
    });
    await s.kill();
  });

  it("holds a turn open with the Stop hook while the checks fail, three times at most", async () => {
    let asked = 0;
    const s = await start(codexHomeIn("reply"), {
      onStop: async () => {
        asked++;
        return "npm test fails";
      },
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(asked).toBe(3);
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
    expect((events.at(-1) as { text: string }).text).toContain("Fixed: npm test fails");
    await s.kill();
  });

  it("says when a thread to resume is gone", async () => {
    const s = await start(codexHomeIn("reply"), { resumeFrom: "no-such-thread" });
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(events.at(-1)).toMatchObject({ reason: "error" });
    expect((events.at(-1) as { error: string }).error).toContain("No saved session");
    await s.kill();
  });

  it("runs inside the sandbox with its CODEX_HOME, and its hook reaches Oraknid from there", async () => {
    const sandbox = createBwrapSandbox();
    if (!sandbox.status().available) return;
    const codexHome = codexHomeIn("tool");
    const home = mkdtempSync(join(tmpdir(), "oraknid-codex-boxed-home-"));
    const node = dirname(process.execPath);
    const rec = permissionRecorder({ allow: true });
    const s = await createCodexAdapter().start({
      leg: leg(codexHome),
      model: "gpt-6-sol",
      effort: "high",
      cwd: mkdtempSync(join(tmpdir(), "oraknid-codex-boxed-")),
      systemPrompt: "",
      prompt: "Run it.",
      resumeFrom: null,
      sandbox: {
        sandbox,
        home,
        configDir: codexHome,
        writable: [],
        readonly: [dirname(FAKE_CODEX), node],
        env: { PATH: `${node}:/usr/bin:/bin`, LANG: "C.UTF-8" },
      },
      credential: null,
      onPermission: rec.onPermission,
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 30_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "Ran it." });
    expect(rec.asked.map((r) => r.command)).toEqual(["echo hi"]);
    expect(existsSync(join(codexHome, "sessions", `${s.nativeSessionId()}.json`))).toBe(true);
    await s.kill();
  }, 60_000);

  legContract("codex", () => {
    // One CODEX_HOME per harness: a resumed session finds its thread.
    let home: string | null = null;
    return {
      supportsResume: true,
      start: async (script, overrides) => {
        home ??= codexHomeIn(script);
        writeFileSync(join(home, ".fake-codex-mode"), script);
        return start(home, overrides);
      },
    };
  });
});
