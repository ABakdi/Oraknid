import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { events, jobs } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import type { Router } from "./router.ts";

// No sandbox → jobs refused unless I explicitly start one without it (ADR-006).

let daemon: Daemon | undefined;
let dir: string | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function start(available: boolean) {
  dir = mkdtempSync(join(tmpdir(), "oraknid-sandbox-"));
  const fake = fakeOs({ keychain: true });
  const os = {
    ...fake.os,
    sandbox: {
      wrap: (spec: { command: string; args: string[] }) => ({
        command: spec.command,
        args: spec.args,
      }),
      status: () => ({ available, detail: "bwrap can't make a user namespace here." }),
    },
  };
  const ran: string[] = [];
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os,
    adapters: {},
    program: async (ctx) => {
      ran.push(ctx.jobId);
    },
  });
  const d = daemon;
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  return { d, api, ran };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a job without the sandbox", () => {
  it("is refused when the sandbox doesn't work, in words that say what to do", async () => {
    const { d, api, ran } = await start(false);
    const job = seedJob(d.db, "draft");
    await expect(api.jobs.start({ id: job })).rejects.toThrow(
      /The sandbox doesn't work on this computer \(bwrap can't make a user namespace here\), so the job can't start\. Fix it \(oraknid doctor says how\), or start this job without the sandbox/,
    );
    await wait(20);
    expect(ran).toEqual([]);
    expect(d.db.select().from(jobs).where(eq(jobs.id, job)).get()?.state).toBe("draft");
  });

  it("asks for a confirmation before running without it", async () => {
    const { d, api, ran } = await start(false);
    const job = seedJob(d.db, "draft");
    await expect(api.jobs.start({ id: job, unsandboxed: true })).rejects.toThrow(/confirm it/);
    expect(d.db.select().from(jobs).where(eq(jobs.id, job)).get()?.unsandboxed).toBe(false);
    expect(ran).toEqual([]);
  });

  it("starts when I explicitly run it without the sandbox: marked, and audited", async () => {
    const { d, api, ran } = await start(false);
    const job = seedJob(d.db, "draft");
    await api.jobs.start({ id: job, unsandboxed: true, confirm: true });
    await wait(50);
    expect(ran).toEqual([job]);
    expect(d.db.select().from(jobs).where(eq(jobs.id, job)).get()?.unsandboxed).toBe(true);
    const audit = d.db.select().from(events).where(eq(events.type, "job.unsandboxed")).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe("owner");
  });

  it("starts as before when the sandbox works", async () => {
    const { d, api, ran } = await start(true);
    const job = seedJob(d.db, "draft");
    await api.jobs.start({ id: job });
    await wait(50);
    expect(ran).toEqual([job]);
    expect(d.db.select().from(jobs).where(eq(jobs.id, job)).get()?.unsandboxed).toBe(false);
  });
});
