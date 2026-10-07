import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, projects, skills } from "../db/schema.ts";
import { tagConsoleWithRequestIds, withRequestId } from "../http/request-id.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import type { Router } from "./router.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const ULID = (n: number) => `01J9Z3K8W2Q4V6X8Y0A1B2C3D${n}`;
const SECRET = "the-nest-secret-0123456789";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-records-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
  });
  const d = daemon;
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  d.db
    .insert(projects)
    .values({
      id: ULID(1),
      name: "Site",
      workspacePath: "/tmp/site",
      isGitRepo: true,
      releaseBranch: "main",
      workBranch: "dev",
      createdAt: 0,
    })
    .run();
  d.db
    .insert(skills)
    .values({
      id: ULID(2),
      version: 1,
      name: "s",
      description: "",
      source: "built-in",
      body: "",
      interview: false,
      requiredTools: [],
      verify: [],
      createdAt: 0,
    })
    .run();
  d.db
    .insert(jobs)
    .values({
      id: ULID(3),
      projectId: ULID(1),
      title: "Deploy with ghp_abcdefghijklmnopqrstuvwxyz0123",
      goal: `Deploy, the Nest secret is ${SECRET}`,
      inputs: [],
      skillId: ULID(2),
      skillVersion: 1,
      autonomy: "auto",
      allowedLegIds: [],
      budget: {
        tokens: null,
        quotaShare: null,
        wallClockMs: null,
        money: { limit: 0, hard: true },
      },
      state: "completed",
      createdAt: 0,
    })
    .run();
  await d.secrets.set("nest-secret", SECRET);
  d.bus.publish({
    type: "job.note",
    topic: `job:${ULID(3)}`,
    jobId: ULID(3),
    payload: { text: "deployed" },
  });
  return { d, api };
}

/** A raw call, to see the response's headers and the error's body. */
async function raw(d: Daemon, path: string, input: unknown) {
  const res = await fetch(`${d.url}/api/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.cliToken}`, "content-type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  return { res, body: (await res.json()) as { json: Record<string, unknown> } };
}

describe("projects.get (Audit 1 → Q1-15)", () => {
  it("returns one project as list does, and NOT_FOUND for another id", async () => {
    const { api } = await start();
    const p = await api.projects.get({ id: ULID(1) });
    expect(p).toEqual((await api.projects.list())[0]);
    expect(p.jobCount).toBe(1);
    await expect(api.projects.get({ id: ULID(9) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("jobs.export (Audit 1 → Q1-15)", () => {
  it("carries the job's whole record, with secrets scrubbed", async () => {
    const { api } = await start();
    const e = await api.jobs.export({ id: ULID(3) });
    expect(e.format).toBe("oraknid.job-export");
    expect(e.version).toBe(1);
    expect(e.job.id).toBe(ULID(3));
    expect(e.events.map((x) => x.type)).toContain("job.note");
    expect(e.attempts).toEqual([]);
    expect(e.sessions).toEqual([]);
    expect(Array.isArray(e.silk)).toBe(true);
    expect(e.result).toMatchObject({ branch: null });
    const text = JSON.stringify(e);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(e.job.goal).toBe("Deploy, the Nest secret is [secret]");
    expect(e.job.title).toBe("Deploy with [secret]");
  });

  it("refuses a job that doesn't exist", async () => {
    const { api } = await start();
    await expect(api.jobs.export({ id: ULID(8) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a request id on every API call", () => {
  it("is made per request and given back in the header", async () => {
    const { d } = await start();
    const a = await raw(d, "projects/list", undefined);
    const b = await raw(d, "projects/list", undefined);
    expect(a.res.status).toBe(200);
    const ida = a.res.headers.get("x-request-id");
    expect(ida).toMatch(/^r-[0-9a-f]{12}$/);
    expect(b.res.headers.get("x-request-id")).not.toBe(ida);
  });

  it("is not taken from the client", async () => {
    const { d } = await start();
    const res = await fetch(`${d.url}/api/projects/list`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${d.cliToken}`,
        "content-type": "application/json",
        "x-request-id": "mine",
      },
      body: JSON.stringify({ json: undefined }),
    });
    expect(res.headers.get("x-request-id")).toMatch(/^r-[0-9a-f]{12}$/);
  });

  it("is in an error's body, the same as its header", async () => {
    const { d } = await start();
    const missing = await raw(d, "projects/get", { id: ULID(9) });
    expect(missing.res.status).toBe(404);
    const id = missing.res.headers.get("x-request-id");
    expect((missing.body.json.data as { requestId?: string }).requestId).toBe(id);
    // A refused input too.
    const bad = await raw(d, "projects/get", { id: 5 });
    expect(bad.res.status).toBe(400);
    expect((bad.body.json.data as { requestId?: string }).requestId).toBe(
      bad.res.headers.get("x-request-id"),
    );
  });

  it("is in an error refused before the API (a wrong token is 401, a locked device 423)", async () => {
    const { d } = await start();
    const res = await fetch(`${d.url}/api/projects/list`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("x-request-id")).toMatch(/^r-[0-9a-f]{12}$/);
  });

  it("starts the log lines printed while the request runs", () => {
    const lines: string[] = [];
    const target = {
      log: (...a: unknown[]) => lines.push(a.join(" ")),
      warn: (...a: unknown[]) => lines.push(a.join(" ")),
      error: (...a: unknown[]) => lines.push(a.join(" ")),
    };
    tagConsoleWithRequestIds(target);
    tagConsoleWithRequestIds(target);
    withRequestId("r-0123456789ab", () => target.error("request failed", "boom"));
    target.log("outside");
    expect(lines).toEqual(["[r-0123456789ab] request failed boom", "outside"]);
  });
});
