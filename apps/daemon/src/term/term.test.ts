import { spawnSync } from "node:child_process";
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

  it("opens a terminal in a project's folder, by the project's id only, and opens its folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-term-"));
    const folder = mkdtempSync(join(tmpdir(), "oraknid-term-project-"));
    spawnSync("git", ["init", "-q", folder]);
    const opened: string[] = [];
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: {},
      openPath: (p) => opened.push(p),
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    await api.settings.setTerminal({ enabled: true });
    // A folder that isn't a git repo is refused in words, not as an error inside Oraknid.
    const loose = mkdtempSync(join(tmpdir(), "oraknid-term-loose-"));
    await expect(api.projects.create({ name: "loose", workspacePath: loose })).rejects.toThrow(
      /is not a git repo\. Choose: make it one/,
    );
    const project = await api.projects.create({ name: "piano", workspacePath: folder });
    await api.projects.openFolder({ id: project.id });
    expect(opened).toEqual([folder]);
    const shell = async (target: string) => {
      const ws = new WebSocket(
        `${daemon?.url.replace("http", "ws")}/term?target=${encodeURIComponent(target)}&cols=80&rows=24&token=${daemon?.cliToken}`,
      );
      let out = "";
      ws.on("message", (d) => {
        out += String(d);
      });
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ t: "in", d: "echo at:$(pwd):end\r" }));
      const end = Date.now() + 8000;
      while (!/at:\/\S*:end|isn.t here/.test(out) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      ws.close();
      return out;
    };
    expect(await shell(`project:${project.id}`)).toContain(`at:${folder}:end`);
    // An id that is no project of mine opens nothing.
    expect(await shell("project:nope")).toMatch(/That project's folder isn't here/);
  }, 30_000);
});
