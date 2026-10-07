import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { remoteAllowed } from "../auth/lock.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";

// A project's secrets through the API (ADR-059): a value goes in and never
// comes back out, in a list, an event or the audit.

let daemon: Daemon | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("projectSecrets API (ADR-059)", () => {
  it("sets, lists masked, imports a .env, keeps a job's environment, and never returns a value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-secrets-api-"));
    const ws = mkdtempSync(join(tmpdir(), "oraknid-secrets-ws-"));
    dirs.push(dir, ws);
    spawnSync("git", ["init", "-q", "-b", "main", ws]);
    writeFileSync(join(ws, "README.md"), "# demo\n");
    spawnSync("git", ["-C", ws, "add", "."]);
    spawnSync("git", [
      "-C",
      ws,
      "-c",
      "user.email=me@example.com",
      "-c",
      "user.name=Me",
      "commit",
      "-qm",
      "start",
    ]);
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const project = await api.projects.create({ name: "demo", workspacePath: ws });
    const value = "pk_live_abcdefghijklmnop0123";
    const s = await api.projectSecrets.set({
      projectId: project.id,
      environment: "production",
      name: "PAYMENT_KEY",
      value,
    });
    expect(s.masked).toBe("••••••••");
    const imported = await api.projectSecrets.importDotEnv({
      projectId: project.id,
      environment: "dev",
      text: "A=1\nB='two'\nHOME=/x\n",
    });
    expect(imported).toEqual({
      set: ["A", "B"],
      skipped: [{ line: 3, reason: "HOME is set by Oraknid itself" }],
    });
    await expect(
      api.projectSecrets.set({
        projectId: project.id,
        environment: "dev",
        name: "bad name",
        value: "x",
      }),
    ).rejects.toThrow();
    const list = await api.projectSecrets.list({ projectId: project.id });
    expect(list.secrets.map((x) => `${x.environment}:${x.name}`)).toEqual([
      "dev:A",
      "dev:B",
      "production:PAYMENT_KEY",
    ]);
    expect(JSON.stringify(list)).not.toContain(value);
    const after = await api.projectSecrets.setDefaultEnvironment({
      projectId: project.id,
      environment: "testing",
    });
    expect(after.defaultEnvironment).toBe("testing");

    const job = await api.jobs.create({
      projectId: project.id,
      goal: "Ship it",
      environment: "production",
    });
    expect(job.id).toBeTruthy();
    const audit = await api.audit.search({ type: "project.secret." });
    expect(JSON.stringify(audit)).not.toContain(value);
    expect(JSON.stringify(audit)).toContain("PAYMENT_KEY");

    await api.projectSecrets.remove({ id: s.id });
    expect((await api.projectSecrets.list({ projectId: project.id })).secrets).toHaveLength(2);
  });

  it("lets a device away from home list, and only one with full rights change", () => {
    expect(remoteAllowed("/projectSecrets/list")).toBe(true);
    for (const p of ["set", "importDotEnv", "remove", "setDefaultEnvironment"]) {
      expect(remoteAllowed(`/projectSecrets/${p}`)).toBe(false);
      expect(remoteAllowed(`/projectSecrets/${p}`, true)).toBe(true);
    }
  });
});
