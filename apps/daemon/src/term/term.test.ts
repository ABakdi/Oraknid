import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("the terminal (ADR-028)", () => {
  it("is refused while off, then opens a real shell for a paired device", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-term-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: {},
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const url = (token: string) =>
      `${daemon?.url.replace("http", "ws")}/term?target=local&cols=80&rows=24&token=${token}`;
    const refused = (u: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(u);
        ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
      });
    expect(await refused(url(daemon.cliToken))).toBe(403);
    await api.settings.setTerminal({ enabled: true });
    expect(await refused(url("not-a-token"))).toBe(403);
    const ws = new WebSocket(url(daemon.cliToken));
    let out = "";
    ws.on("message", (d) => {
      out += String(d);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "in", d: "echo ora$((1+1))knid\r" }));
    const end = Date.now() + 8000;
    while (!out.includes("ora2knid") && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain("ora2knid");
    ws.close();
    const types = daemon.bus.since(0, ["overview"], 500).map((e) => e.type);
    expect(types).toContain("terminal.opened");
  }, 20_000);
});
