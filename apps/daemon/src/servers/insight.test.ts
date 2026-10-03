import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Router } from "../api/router.ts";
import { remoteAllowed } from "../auth/lock.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeServerTools } from "../testing/fake-server-tools.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { cleanLine, mergeSites } from "./insight.ts";

// What runs on a server (ADR-043), through the API and the live socket,
// against the stand-in SSH server with stand-in docker, systemctl, nginx.

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

async function ready() {
  const ssh = await fakeSsh({
    password: "pw",
    path: fakeServerTools(),
    env: { ORAKNID_MONITOR_ROOT: mkdtempSync(join(tmpdir(), "oraknid-root-")) },
  });
  closing.push(ssh.close);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-insight-"));
  const discoveries: string[] = [];
  const brain = {
    serverState: async (i: { discovery: string; name: string }) => {
      discoveries.push(i.discovery);
      return { document: `# ${i.name}` };
    },
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
    brain,
    serverSampleSec: 3600,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const s = await api.servers.add({
    name: "shop",
    host: "127.0.0.1",
    port: ssh.port,
    user: "me",
    description: "",
    password: "pw",
  });
  await api.servers.setup({ id: s.id });
  await daemon.servers.sampleAll();
  return { api, ssh, id: s.id, discoveries, d: daemon };
}

describe("what runs on a server (ADR-043)", () => {
  it("reads Docker, databases, the proxy and traffic; shares a reading a few seconds; feeds the state document", async () => {
    const { api, id, discoveries, ssh } = await ready();
    // The state document's discovery has what runs there.
    expect(discoveries[0]).toContain("## What runs (oraknid-monitor)");
    expect(discoveries[0]).toMatch(/- web: app:1, running \(healthy\)/);
    expect(discoveries[0]).toContain("shop.example.com → 127.0.0.1:3000");

    const docker = await api.servers.docker({ id });
    expect(docker.data.containers.map((c) => [c.name, c.health, c.cpuPercent])).toEqual([
      ["web", "healthy", 1.5],
      ["db", null, null],
    ]);
    expect(docker.data.images[0]).toMatchObject({ repository: "app", inUse: true });
    // A second look within seconds is the same reading; fresh asks the server again.
    const asked = ssh.commands.filter((c) => c.includes("sample docker")).length;
    expect((await api.servers.docker({ id })).at).toBe(docker.at);
    expect(ssh.commands.filter((c) => c.includes("sample docker")).length).toBe(asked);
    await api.servers.docker({ id, fresh: true });
    expect(ssh.commands.filter((c) => c.includes("sample docker")).length).toBe(asked + 1);

    const dbs = await api.servers.databases({ id });
    expect(dbs.data.databases).toEqual([
      expect.objectContaining({ kind: "postgres", name: "db", source: "container", version: "16" }),
    ]);
    const proxy = await api.servers.proxy({ id });
    expect(proxy.data.proxies[0]).toMatchObject({
      kind: "nginx",
      state: "active",
      version: "1.24.0",
      sites: [
        expect.objectContaining({ names: ["shop.example.com"], upstreams: ["127.0.0.1:3000"] }),
      ],
    });
    // nginx -t needs root here, and sudo asks a password: said so, not run.
    expect(proxy.data.proxies[0]?.check).toMatchObject({ ok: null });
    const traffic = await api.servers.traffic({ id });
    expect(traffic.data.connections).toEqual([{ port: "443", count: 1 }]);
  }, 120_000);

  it("lists the logs, reads one with a search, and follows one until the screen closes", async () => {
    const { api, id, ssh, d } = await ready();
    const sources = await api.servers.logSources({ id });
    expect(sources.map((s) => s.id)).toEqual(
      expect.arrayContaining(["unit:nginx.service", "container:web", "container:db"]),
    );
    const all = await api.servers.logs({ id, source: "container:web" });
    // Colours gone, the lines as printed.
    expect(all.lines[0]).toBe("2026-10-03T18:00:00Z ready");
    const found = await api.servers.logs({ id, source: "container:web", search: "ERROR" });
    expect(found.lines).toEqual(["2026-10-03T18:00:02Z error: payment failed"]);
    // The journal's header line isn't a log line.
    const unit = await api.servers.logs({ id, source: "unit:nginx.service" });
    expect(unit.lines).toEqual(["2026-10-03T18:00:00+0000 host nginx[1]: started"]);
    await expect(api.servers.logs({ id, source: "file:/etc/../shadow" })).rejects.toThrow();

    // Followed on the live socket: lines come, then closing stops it on the server.
    const ws = new WebSocket(`${d.url.replace("http", "ws")}/live?token=${d.cliToken}`);
    const frames: ServerFrame[] = [];
    ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "logs-open", id: "L1", serverId: id, source: "container:web" }));
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(f()).toBe(true);
    };
    await until(() =>
      frames.some((f) => f.type === "log" && f.lines.some((l) => l.includes("tick 3"))),
    );
    const pidFile = join(ssh.home, "follower.pid");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    ws.send(JSON.stringify({ type: "logs-close", id: "L1" }));
    await until(() => !alive());
    // A fifth log at once is refused; closing the socket stops the others.
    for (const n of [1, 2, 3, 4, 5])
      ws.send(
        JSON.stringify({
          type: "logs-open",
          id: `M${n}`,
          serverId: id,
          source: "unit:nginx.service",
        }),
      );
    await until(() => frames.some((f) => f.type === "log-end" && f.id === "M5" && !!f.error));
    ws.close();
  }, 120_000);

  it("restarts a container when asked with my yes, refuses what isn't there, says when root is needed; audited", async () => {
    const { api, id, ssh, d } = await ready();
    // Never without the yes, and never from a standard device away from home.
    await expect(
      api.servers.restart({ id, kind: "container", name: "web" } as never),
    ).rejects.toThrow();
    expect(remoteAllowed("/servers/restart")).toBe(false);
    expect(remoteAllowed("/servers/restart", true)).toBe(true);
    expect(remoteAllowed("/servers/docker")).toBe(true);

    expect(
      await api.servers.restart({ id, kind: "container", name: "web", confirm: true }),
    ).toEqual({ ok: true });
    expect(readFileSync(join(ssh.home, "restarted"), "utf8")).toBe("web\n");
    await expect(
      api.servers.restart({ id, kind: "container", name: "nope", confirm: true }),
    ).rejects.toThrow(/No container nope/);
    await expect(
      api.servers.restart({ id, kind: "service", name: "nginx", confirm: true }),
    ).rejects.toThrow(/needs root/);
    await expect(
      api.servers.restart({ id, kind: "service", name: "cron", confirm: true }),
    ).rejects.toThrow(/No service cron.service/);
    const audit = d.db.$client
      .prepare("select payload, actor from events where type = 'server.restarted' order by seq")
      .all() as { payload: string; actor: string }[];
    expect(
      audit.map((a) => [JSON.parse(a.payload).name, JSON.parse(a.payload).ok, a.actor]),
    ).toEqual([
      ["web", true, "owner"],
      ["nginx", false, "owner"],
    ]);
  }, 120_000);

  it("merges nginx's blocks of one site and cleans log lines", () => {
    expect(
      mergeSites([
        {
          names: ["a.com"],
          listen: ["80"],
          upstreams: [],
          root: null,
          redirect: "301 https://a.com",
          certificate: null,
          accessLog: null,
        },
        {
          names: ["a.com"],
          listen: ["443"],
          upstreams: ["127.0.0.1:1"],
          root: null,
          redirect: null,
          certificate: "/c.pem",
          accessLog: null,
        },
        {
          names: [],
          listen: ["80"],
          upstreams: [],
          root: "/var/www/html",
          redirect: null,
          certificate: null,
          accessLog: null,
        },
      ]),
    ).toEqual([
      {
        names: ["a.com"],
        listen: ["80", "443"],
        upstreams: ["127.0.0.1:1"],
        root: null,
        redirect: null,
        certificate: "/c.pem",
        accessLog: null,
      },
      {
        names: [],
        listen: ["80"],
        upstreams: [],
        root: "/var/www/html",
        redirect: null,
        certificate: null,
        accessLog: null,
      },
    ]);
    expect(cleanLine("\x1b[31mred\x1b[0m\r")).toBe("red");
  });
});
