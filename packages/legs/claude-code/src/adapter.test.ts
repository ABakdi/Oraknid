import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { emptyUsage, type SessionStart } from "@oraknid/leg-sdk";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter, type QueryFn, toRequest } from "./adapter.ts";
import { fakeQuery } from "./fake-query.ts";

const leg = {
  id: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
  name: "Claude — personal",
  kind: "claude-code" as const,
  config: { binary: "/usr/bin/claude", configDir: "/home/me/.oraknid-legs/claude-1" },
};

const start = (over: Partial<SessionStart> = {}): SessionStart => ({
  leg,
  model: "sonnet",
  effort: null,
  cwd: "/tmp/work",
  systemPrompt: "context pack",
  prompt: "do the task",
  resumeFrom: null,
  sandbox: null,
  credential: null,
  onPermission: async () => ({ allow: true }),
  ...over,
});

legContract("Claude Code (scripted SDK)", () => {
  // A new script per session, as the harness asks for.
  return {
    supportsResume: true,
    start: (script, over) =>
      createClaudeCodeAdapter({ query: fakeQuery(script) }).start(start(over)),
  };
});

describe("Claude Code adapter", () => {
  it("keeps my host setup out and routes every permission through The Eye", async () => {
    const seen: { options: Options[] } = { options: [] };
    const s = await createClaudeCodeAdapter({ query: fakeQuery("reply", seen) }).start(
      start({ model: "opus", effort: "high" }),
    );
    await readUntil(s, (e) => e.type === "turn.ended");
    const o = seen.options[0] as unknown as Record<string, unknown>;
    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.permissionMode).toBe("default");
    expect(o.canUseTool).toBeTypeOf("function");
    expect(o.model).toBe("opus");
    expect(o.effort).toBe("high");
    expect((o.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(
      "/home/me/.oraknid-legs/claude-1",
    );
    expect(o.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "context pack",
    });
    await s.kill();
  });

  it("reads usage from the result, including the context window", async () => {
    const s = await createClaudeCodeAdapter({ query: fakeQuery("reply") }).start(start());
    await readUntil(s, (e) => e.type === "turn.ended");
    expect(s.usage()).toEqual({
      ...emptyUsage(),
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      contextTokens: 150,
      contextWindow: 200_000,
    });
    await s.kill();
  });

  it("turns a rejected window into a quota report in milliseconds, scoped to the account", async () => {
    const s = await createClaudeCodeAdapter({ query: fakeQuery("rate-limit") }).start(start());
    const events = await readUntil(s, (e) => e.type === "turn.ended");
    expect(events.find((e) => e.type === "rate_limit")).toEqual({
      type: "rate_limit",
      quota: {
        window: "five_hour",
        scope: "account",
        status: "rejected",
        utilization: 1,
        resetsAt: 1_790_000_000_000,
      },
    });
    await s.kill();
  });

  it("probes models and the account without sending a message", async () => {
    const seen: { options: Options[] } = { options: [] };
    const p = await createClaudeCodeAdapter({ query: fakeQuery("reply", seen) }).probe(leg, null);
    expect(p.ok).toBe(true);
    expect(p.detail).toBe("Signed in as me@example.com (max).");
    expect(p.models.map((m) => [m.model, m.effortLevels])).toEqual([
      ["opus", ["low", "medium", "high"]],
      ["haiku", []],
    ]);
  });

  it("says a logged-out account is not logged in, even though Claude Code answers (seen live)", async () => {
    const logged = fakeQuery("reply");
    const out: QueryFn = (params) => {
      const q = logged(params);
      return Object.assign(q, { accountInfo: async () => ({}) });
    };
    const p = await createClaudeCodeAdapter({ query: out }).probe(leg, null);
    expect(p).toMatchObject({ ok: false, detail: "Not logged in: press Log in on its card." });
  });

  it("refuses to probe a Leg with no config directory, and says what to do", async () => {
    const p = await createClaudeCodeAdapter({ query: fakeQuery("reply") }).probe(
      { ...leg, config: { binary: "claude" } },
      null,
    );
    expect(p).toMatchObject({
      ok: false,
      detail: "No config directory: log in with the official binary first.",
    });
  });

  it("names the command or path a permission request is about", () => {
    expect(toRequest("Bash", { command: "rm -rf build" })).toMatchObject({
      command: "rm -rf build",
      path: null,
    });
    expect(toRequest("Edit", { file_path: "/w/a.ts" })).toMatchObject({
      command: null,
      path: "/w/a.ts",
    });
  });
});
