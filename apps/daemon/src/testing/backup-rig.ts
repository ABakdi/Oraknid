import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../api/router.ts";
import { type Daemon, type DaemonOptions, startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "./fake-os.ts";

// Backups' test rig (ADR-044): a daemon with a stand-in keychain, throwaway
// Docker containers (removed after), and a watch on every process's
// command line for a secret.

export type Api = RouterClient<Router>;

export const hasDocker =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status ===
  0;

export async function rigDaemon(o: Partial<DaemonOptions> & { dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "oraknid-backups-"));
  const fake = fakeOs({ keychain: true });
  const daemon: Daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    adapters: {},
    brain: {} as EyeBrain,
    serverSampleSec: 3600,
    backupTickMs: 3600_000,
    ...o,
  });
  const api = createORPCClient<Api>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { daemon, api, dir, fake };
}

/** Waits for a run to end, through the API. */
export async function settle(api: Api, runId: string, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = (await api.backups.runs({ limit: 500 })).find((x) => x.id === runId);
    if (r && r.state !== "running") return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`run ${runId} didn't end`);
}

export const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A container's log, stdout and stderr. */
export const logs = (name: string) => {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

const started: string[] = [];

/** A throwaway container, removed by `removeContainers`. */
export function container(name: string, args: string[]): string {
  const full = `oraknid-test-${name}-${Math.random().toString(36).slice(2, 8)}`;
  docker("run", "-d", "--name", full, ...args);
  started.push(full);
  return full;
}

export function removeContainers() {
  for (const c of started.splice(0)) spawnSync("docker", ["rm", "-f", "-v", c]);
}

export async function until(what: string, ok: () => boolean, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (ok()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: not ready in time`);
}

/** Every process's command line, looked at often while `fn` runs: any holding `secret`? */
export async function watchArgv<T>(secret: string, fn: () => Promise<T>) {
  const seen: string[] = [];
  let looks = 0;
  const look = () => {
    looks++;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmd.includes(secret)) seen.push(cmd.replaceAll("\0", " "));
      } catch {}
    }
  };
  const timer = setInterval(look, 2);
  try {
    const result = await fn();
    return { result, seen, looks };
  } finally {
    clearInterval(timer);
    look();
  }
}

/** A real sshd in a container, as a second server: its address and login. */
export async function sshdContainer() {
  const name = container("sshd", [
    "-p",
    "127.0.0.1::22",
    "alpine:3.22",
    "sh",
    "-c",
    "apk add --no-cache openssh-server >/dev/null && ssh-keygen -A >/dev/null && adduser -D me && echo me:pw-dest | chpasswd && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes",
  ]);
  await until("sshd", () => logs(name).includes("Server listening"));
  const port = Number(docker("port", name, "22").split("\n")[0]?.split(":").pop());
  return { name, port, user: "me", password: "pw-dest" };
}
