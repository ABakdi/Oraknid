import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { EventBus } from "../events/bus.ts";
import { isBrokered } from "../eye/attempt.ts";
import { Secrets } from "../os/secrets.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type BrokerHooks, McpBroker } from "./broker.ts";
import { ToolRegistry } from "./registry.ts";

const FAKE = fileURLToPath(new URL("../testing/fake-mail-mcp.mjs", import.meta.url));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-tools-"));
  const db = await openDatabase({ file: ":memory:", backupsDir: join(dir, "b") });
  const bus = new EventBus(db, Date.now);
  const secrets = new Secrets(dir, fakeOs({ keychain: true }).os.keychain);
  await secrets.init();
  const registry = new ToolRegistry(db, bus, secrets);
  const tool = await registry.create({
    name: "email",
    description: "My mail",
    command: process.execPath,
    args: [FAKE],
    env: {},
    secrets: { MAIL_PASSWORD: "hunter2" },
    reads: ["list_messages"],
    sends: ["send_email"],
    untrusted: true,
  });
  return { registry, tool, db, secrets };
}

/** Speaks JSON-RPC to a bridge, as a Leg's MCP client would. */
function client(server: { command: string; args: string[] }) {
  const child: ChildProcess = spawn(server.command, server.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map<number, (m: unknown) => void>();
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const m = JSON.parse(buf.slice(0, i)) as { id: number };
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
      i = buf.indexOf("\n");
    }
  });
  let next = 1;
  return {
    call: (method: string, params: unknown = {}) =>
      new Promise<{ result?: { content: { text: string }[]; isError?: boolean } }>((resolve) => {
        const id = next++;
        waiting.set(id, resolve as (m: unknown) => void);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    close: () => child.kill(),
  };
}

const hooks = (decide: BrokerHooks["decide"]) => {
  const done: { name: string; allowed: boolean; flags: string[] }[] = [];
  return {
    done,
    hooks: {
      decide,
      done: (_t, name, o) => done.push({ name, allowed: o.allowed, flags: o.flags }),
    } satisfies BrokerHooks,
  };
};

describe("tools for skills (ADR-021)", () => {
  it("keeps a tool's secrets out of the database, and says what the policy should know", async () => {
    const { registry, tool, db } = await setup();
    expect(JSON.stringify(db.$client.prepare("select * from tools").all())).not.toContain(
      "hunter2",
    );
    expect((await registry.view(tool, ["mail-triage"])).missingSecrets).toEqual([]);
    expect([...registry.declarations([tool])]).toEqual([
      ["mcp__email__list_messages", "read"],
      ["mcp__email__send_email", "send"],
    ]);
    expect(registry.missing(["email", "calendar"])).toEqual(["calendar"]);
    await expect(registry.create({ ...tool, secrets: {} } as never)).rejects.toThrow(/exists/);
  });

  for (const boxed of [false, true]) {
    it(`runs the server ${boxed ? "in its sandbox" : "unsandboxed"} with its secret, judges each call, and wraps what it returns`, async () => {
      const sandbox = createBwrapSandbox();
      if (boxed && !sandbox.status().available) return;
      const { registry, tool } = await setup();
      const asked: string[] = [];
      const h = hooks(async (_t, name) => {
        asked.push(name);
        return name === "send_email" ? { allow: false, message: "I denied it." } : { allow: true };
      });
      const broker = new McpBroker({ registry, sandbox: boxed ? sandbox : null });
      const session = await broker.open([tool], h.hooks);
      const server = session.servers["oraknid-email"];
      expect(server?.args[0]).toMatch(/bridge\.mjs$/);
      const c = client(server as { command: string; args: string[] });
      try {
        expect((await c.call("initialize")).result).toBeDefined();
        const listed = await c.call("tools/call", { name: "list_messages", arguments: {} });
        const text = listed.result?.content[0]?.text ?? "";
        // The secret reached the server (it answered), and its answer is wrapped as data.
        expect(text).toContain("<untrusted source=");
        expect(text).toContain("Subject: Q3");
        const sent = await c.call("tools/call", { name: "send_email", arguments: { to: "x" } });
        expect(sent.result).toMatchObject({ isError: true, content: [{ text: "I denied it." }] });
        expect(asked).toEqual(["list_messages", "send_email"]);
        expect(h.done.map((d) => [d.name, d.allowed])).toEqual([
          ["list_messages", true],
          ["send_email", false],
        ]);
        expect(h.done[0]?.flags.length).toBeGreaterThan(0);
      } finally {
        c.close();
        session.close();
      }
    }, 30_000);
  }

  it("knows a Leg's call to one of its bridges, whatever the Leg calls it, and nothing else", () => {
    const servers = ["oraknid-email"];
    expect(isBrokered("mcp__oraknid-email__send_email", servers)).toBe(true);
    expect(isBrokered("oraknid-email_send_email", servers)).toBe(true);
    expect(isBrokered("oraknid_email_send_email", servers)).toBe(true);
    expect(isBrokered("mcp__email__send_email", servers)).toBe(false);
    expect(isBrokered("mcp__oraknid-emailer__x", servers)).toBe(false);
    expect(isBrokered("Bash", servers)).toBe(false);
  });

  it("fails a session's start when a secret is missing, saying which", async () => {
    const { registry, tool, secrets } = await setup();
    await secrets.delete(`tool.${tool.id}.MAIL_PASSWORD`);
    const broker = new McpBroker({ registry, sandbox: null });
    await expect(broker.open([tool], hooks(async () => ({ allow: true })).hooks)).rejects.toThrow(
      /missing its secret MAIL_PASSWORD/,
    );
  });
});
