import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { failureSaid, type Router } from "./router.ts";

// The Keys job (2026-10-13): blocked while verifying, every Start failed with
// "A job cannot go from blocked to verifying." and the UI said to read the log.

let daemon: Daemon | undefined;
let dir: string | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("starting (resuming) a blocked job", () => {
  it("goes back to verifying, where it was blocked", async () => {
    dir = mkdtempSync(join(tmpdir(), "oraknid-start-blocked-"));
    const states: string[] = [];
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: {},
      program: async (ctx) => {
        states.push(ctx.state());
      },
    });
    const d = daemon;
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
    );
    const id = seedJob(d.db, "blocked");
    d.db
      .update(jobs)
      .set({ resumeState: "verifying", blockedReason: "No Leg can think for The Eye right now: …" })
      .where(eq(jobs.id, id))
      .run();
    await api.jobs.resume({ id });
    const end = Date.now() + 2000;
    while (!states.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(states).toEqual(["verifying"]);
  });
});

describe("an unexpected failure, said in the UI", () => {
  it("says what went wrong in its own words, not only where the log is", () => {
    expect(failureSaid(new Error("SQLITE_BUSY: database is locked\n    at x (y.ts:1)"))).toBe(
      "Something went wrong inside Oraknid: SQLITE_BUSY: database is locked. The details are in its log (oraknid logs).",
    );
    expect(
      failureSaid(new Error("token sk-ant-abcdefghijklmnopqrstuvwxyz0123 refused")),
    ).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(failureSaid(null)).toBe(
      "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    );
  });
});
