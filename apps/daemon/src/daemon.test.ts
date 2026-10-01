import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerFrame } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Router } from "./api/router.ts";
import { type Daemon, startDaemon } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";
import { fakeOs } from "./testing/fake-os.ts";
import { VERSION } from "./version.ts";

let daemon: Daemon;
let dir = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oraknid-daemon-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
  });
});
afterEach(() => daemon.close());

const client = () =>
  createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );

/** Collects frames from a live socket so tests can wait for them in order. */
function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/live?token=${daemon.cliToken}`, {
    headers,
  });
  const frames: ServerFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (d) => {
    frames.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (f: ServerFrame[]) => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!pred(frames)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(frames)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, frames, until, send, opened };
}

const events = (frames: ServerFrame[]) =>
  frames.flatMap((f) => (f.type === "event" ? [f.event] : []));

describe("daemon API", () => {
  it("reports its status over /api", async () => {
    const status = await client().system.status();
    expect(status.version).toBe(VERSION);
    expect(status.pid).toBe(process.pid);
    // system.started was published at boot.
    expect(status.lastSeq).toBeGreaterThanOrEqual(1);
  });

  it("answers with a code and a sentence, never with internals (Audit 1 → Q1-14)", async () => {
    await expect(client().jobs.get({ id: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client().web.edit({
        jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
        edits: [{ op: "remove", taskId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D5" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shows the last lines of its own log (Phase 2 → M2.0)", async () => {
    const file = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }).daemonLog;
    expect(await client().logs.tail({ lines: 5 })).toMatchObject({ lines: [] });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
        .join("\n")
        .concat("\n"),
    );
    expect((await client().logs.tail({ lines: 3 })).lines).toEqual([
      "line 10",
      "line 11",
      "line 12",
    ]);
  });

  it("runs doctor checks and says what each one found", async () => {
    const checks = await client().system.doctor();
    expect(checks.map((c) => c.name)).toContain("Node.js");
    for (const c of checks) {
      expect(c.detail.length).toBeGreaterThan(0);
      if (!c.ok) expect(c.fix).toBeTruthy();
    }
  });

  it("refuses a request from a web page on another origin", async () => {
    const status = await rawGet("/health", { Origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(await rawGet("/health", {})).toBe(200);
  });

  it("refuses a request addressed to a non-local host name (DNS rebinding)", async () => {
    expect(await rawGet("/health", { Host: `evil.example:${daemon.port}` })).toBe(403);
  });
});

describe("live socket", () => {
  it("says hello, then delivers only subscribed topics, live", async () => {
    const c = connect();
    await c.opened;
    await c.until((f) => f.some((x) => x.type === "hello"));
    c.send({ type: "subscribe", topics: ["inbox"] });
    await new Promise((r) => setTimeout(r, 50));
    daemon.bus.publish({ type: "a", topic: "overview", jobId: null, payload: null });
    daemon.bus.publish({ type: "b", topic: "inbox", jobId: null, payload: null });
    await c.until((f) => events(f).length >= 1);
    expect(events(c.frames).map((e) => e.type)).toEqual(["b"]);
    c.ws.close();
  });

  it("tells overview that a job changed, coalesced, without storing it (Audit 1 → Q1-05)", async () => {
    const c = connect();
    await c.opened;
    await c.until((f) => f.some((x) => x.type === "hello"));
    c.send({ type: "subscribe", topics: ["overview"] });
    await new Promise((r) => setTimeout(r, 50));
    const job = "job:01J9Z3K8W2Q4V6X8Y0A1B2C3D4";
    daemon.bus.publish({ type: "task.state", topic: job, jobId: null, payload: null });
    daemon.bus.publish({ type: "job.state", topic: job, jobId: null, payload: null });
    daemon.bus.publish({ type: "session.text", topic: job, jobId: null, payload: null });
    await c.until((f) => events(f).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(events(c.frames).map((e) => [e.type, e.topic])).toEqual([["job.state", "overview"]]);
    expect(daemon.bus.since(0, ["overview"], 100).filter((e) => e.type === "job.state")).toEqual(
      [],
    );
    c.ws.close();
  });

  it("replays what was missed after a reconnect, without duplicates", async () => {
    const first = daemon.bus.publish({ type: "x1", topic: "overview", jobId: null, payload: 1 });
    daemon.bus.publish({ type: "x2", topic: "overview", jobId: null, payload: 2 });
    daemon.bus.publish({ type: "y", topic: "inbox", jobId: null, payload: 3 });

    const c = connect();
    await c.opened;
    c.send({ type: "subscribe", topics: ["overview"] });
    c.send({ type: "resume", lastSeq: first.seq });
    c.send({ type: "resume", lastSeq: first.seq });
    await c.until((f) => events(f).length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(events(c.frames).map((e) => e.type)).toEqual(["x2"]);
    c.ws.close();
  });

  it("asks for a snapshot when too much was missed", async () => {
    const insert = daemon.db.$client.prepare(
      "insert into events (at, type, topic, job_id, payload) values (0, 'bulk', 'overview', null, null)",
    );
    daemon.db.$client.transaction(() => {
      for (let i = 0; i < 5001; i++) insert.run();
    })();
    const c = connect();
    await c.opened;
    c.send({ type: "subscribe", topics: ["overview"] });
    c.send({ type: "resume", lastSeq: 0 });
    await c.until((f) => f.some((x) => x.type === "snapshot-needed"));
    expect(events(c.frames)).toEqual([]);
    c.ws.close();
  });

  it("answers a malformed frame with an error instead of dropping the connection", async () => {
    const c = connect();
    await c.opened;
    c.ws.send("not json");
    c.send({ type: "subscribe", topics: ["everything"] });
    await c.until((f) => f.filter((x) => x.type === "error").length === 2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("refuses a socket opened from another origin", async () => {
    const c = connect({ Origin: "https://evil.example" });
    await expect(c.opened).rejects.toThrow(/403/);
  });
});

function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${daemon.url}${path}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
