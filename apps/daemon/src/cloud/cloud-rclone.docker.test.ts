import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  container,
  docker,
  hasDocker,
  removeContainers,
  rigDaemon,
  watchArgv,
} from "../testing/backup-rig.ts";
import { testRclone } from "../testing/cloud-rig.ts";
import { CONFIG_PASSWORD } from "./service.ts";

// Any provider rclone supports, through the form made of its schema
// (ADR-046 → Changed 2026-10-04), end to end with a real rclone: SFTP
// against a plain atmoz/sftp container (unprivileged, throwaway, removed
// after) and WebDAV against `rclone serve webdav` started here. The
// passwords never on a command line while a provider is added and a file
// goes up, nor in a view, an event or SQLite.

const SFTP_IMAGE = process.env.ORAKNID_TEST_SFTP_IMAGE ?? "atmoz/sftp:latest";
const hasSftp =
  hasDocker &&
  (spawnSync("docker", ["image", "inspect", SFTP_IMAGE]).status === 0 ||
    spawnSync("docker", ["pull", "-q", SFTP_IMAGE], { timeout: 300_000 }).status === 0);
const skip = !testRclone
  ? "rclone isn't installed here (set ORAKNID_TEST_RCLONE): the tests of rclone's generic providers are skipped."
  : null;
if (skip) console.warn(skip);
if (!skip && !hasSftp)
  console.warn(`Docker or ${SFTP_IMAGE} isn't available: the SFTP test is skipped.`);

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});
afterAll(removeContainers, 120_000);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 13 + seed * 5) & 0xff;
  return b;
};

/** A port that answers with `banner` (or just accepts, when none). */
async function answers(port: number, banner?: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1");
      s.setTimeout(2000);
      s.once("connect", () => {
        if (!banner) {
          s.destroy();
          resolve(true);
        }
      });
      s.once("data", (d) => {
        s.destroy();
        resolve(String(d).startsWith(banner ?? ""));
      });
      s.once("error", () => resolve(false));
      s.once("close", () => resolve(false));
      s.once("timeout", () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`nothing answered on ${port}`);
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function setup() {
  const r = await rigDaemon({ rclone: () => testRclone });
  closing.push(() => r.daemon.close());
  const auth = { authorization: `Bearer ${r.daemon.cliToken}` };
  const upload = (name: string, body: Buffer, q: Record<string, string> = {}) =>
    fetch(
      `${r.daemon.url}/api/cloud/upload?${new URLSearchParams({ name, size: String(body.length), ...q })}`,
      { method: "POST", headers: auth, body },
    );
  const download = async (url: string) =>
    Buffer.from(await (await fetch(`${r.daemon.url}${url}`)).arrayBuffer());
  const leaks = async (secret: string) => {
    const where = [
      JSON.stringify(await r.api.cloud.providers()),
      JSON.stringify(r.daemon.db.$client.prepare("select type, payload from events").all()),
      JSON.stringify(r.daemon.db.$client.prepare("select * from cloud_providers").all()),
    ];
    return where.filter((w) => w.includes(secret)).length;
  };
  return { ...r, upload, download, leaks };
}

describe.skipIf(!!skip)("any rclone provider from its form, end to end (ADR-046)", () => {
  it.skipIf(!hasSftp)(
    "SFTP: added from the schema's form, a file up, listed and down; its password on no command line",
    async () => {
      const password = `sftp-S3cr3t-${Math.random().toString(36).slice(2, 12)}`;
      // Given in the environment of `docker run`, not its command line.
      process.env.SFTP_USERS = `me:${password}:1001::upload`;
      let name: string;
      try {
        name = container("sftp", ["-p", "127.0.0.1::22", "-e", "SFTP_USERS", SFTP_IMAGE]);
      } finally {
        delete process.env.SFTP_USERS;
      }
      const port = Number(docker("port", name, "22").split("\n")[0]?.split(":").pop());
      await answers(port, "SSH-");

      const { api, daemon, upload, download, leaks } = await setup();
      const form = await api.cloud.backend({ name: "sftp" });
      expect(form.options.find((o) => o.name === "pass")?.password).toBe(true);
      const file = bytes(3_000_000);
      const {
        result: added,
        seen,
        looks,
      } = await watchArgv(password, async () => {
        const step = await api.cloud.addRclone({
          name: "My SFTP",
          backend: "sftp",
          options: { host: "127.0.0.1", port: String(port), user: "me", pass: password },
          folder: "upload/oraknid",
          limitBytes: 100_000_000,
        });
        const id = step.provider?.id as string;
        const res = await upload("photo.bin", file, { folder: "trip", provider: id });
        expect(res.status).toBe(200);
        await api.cloud.list({ path: "trip" });
        return step;
      });
      expect(looks).toBeGreaterThan(5);
      expect(seen).toEqual([]);
      expect(added.question).toBeNull();
      const p = added.provider;
      expect(p).toMatchObject({
        kind: "rclone",
        backend: "sftp",
        detail: "SSH/SFTP · upload/oraknid/",
        error: null,
      });
      // The file is in the pool, and in the server's folder.
      const listing = await api.cloud.list({ path: "trip" });
      expect(listing.entries.map((e) => [e.name, e.size, e.providerId])).toEqual([
        ["photo.bin", file.length, p?.id],
      ]);
      expect(docker("exec", name, "ls", "/home/me/upload/oraknid/trip")).toBe("photo.bin");
      const link = await api.cloud.downloadLink({
        providerId: p?.id as string,
        path: "trip/photo.bin",
      });
      expect(sha(await download(link.url))).toBe(sha(file));
      // Space: the server's own (df), or what it holds against my limit.
      const checked = await api.cloud.checkProvider({ id: p?.id as string });
      expect(checked.error).toBeNull();
      expect(checked.usedBytes).toBeGreaterThanOrEqual(file.length);
      expect(await leaks(password)).toBe(0);

      // A wrong password: refused in rclone's words, nothing kept, the password not said.
      const wrong = `${password}-wrong`;
      const refused = await api.cloud
        .addRclone({
          name: "Bad",
          backend: "sftp",
          options: { host: "127.0.0.1", port: String(port), user: "me", pass: wrong },
          folder: "upload",
        })
        .catch((e: Error) => e);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toMatch(/SSH\/SFTP didn't answer/);
      expect((refused as Error).message).not.toContain(wrong);
      expect((await api.cloud.providers()).map((x) => x.name)).toEqual(["My SFTP"]);
      expect([...(await daemon.cloud.rclone.read()).keys()]).toEqual([`o-${p?.id.toLowerCase()}`]);

      // rclone's own writes to the config (its setup, a refreshed token) are read back by Oraknid.
      const conf = join(daemon.cloud.configFile());
      const pass = (await daemon.secrets?.get(CONFIG_PASSWORD)) ?? "";
      const upd = spawnSync(
        testRclone as string,
        [
          "--config",
          conf,
          "--ask-password=false",
          "config",
          "update",
          `o-${p?.id.toLowerCase()}`,
          "set_modtime",
          "false",
          "--non-interactive",
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH ?? "", RCLONE_CONFIG_PASS: pass } },
      );
      expect(upd.status).toBe(0);
      const section = (await daemon.cloud.rclone.read()).get(`o-${p?.id.toLowerCase()}`);
      expect(section?.get("set_modtime")).toBe("false");
      expect(section?.get("pass")).not.toBe(password);
      expect(section?.get("pass")?.length).toBeGreaterThan(10);
    },
    240_000,
  );

  it("WebDAV: added from its form against rclone's own WebDAV server, a file up, listed and down", async () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-webdav-"));
    const port = await freePort();
    const user = "dav-me";
    const password = `dav-S3cr3t-${Math.random().toString(36).slice(2, 12)}`;
    // The server's login in its environment, so no command line holds it.
    const server: ChildProcess = spawn(
      testRclone as string,
      ["--config", "/dev/null", "serve", "webdav", root, "--addr", `127.0.0.1:${port}`],
      {
        env: { PATH: process.env.PATH ?? "", RCLONE_USER: user, RCLONE_PASS: password },
        stdio: "ignore",
      },
    );
    closing.push(() => server.kill("SIGTERM"));
    await answers(port);
    // It refuses without the login.
    expect((await fetch(`http://127.0.0.1:${port}/`, { method: "PROPFIND" })).status).toBe(401);

    const { api, upload, download, leaks } = await setup();
    const form = await api.cloud.backend({ name: "webdav" });
    expect(form.options.find((o) => o.name === "url")?.required).toBe(true);
    expect(form.options.find((o) => o.name === "vendor")?.examples.map((e) => e.value)).toContain(
      "rclone",
    );
    const doc = bytes(1_500_000, 3);
    const { result, seen } = await watchArgv(password, async () => {
      const step = await api.cloud.addRclone({
        name: "My WebDAV",
        backend: "webdav",
        options: { url: `http://127.0.0.1:${port}/`, vendor: "rclone", user, pass: password },
        folder: "Oraknid",
        unlimited: true,
      });
      const id = step.provider?.id as string;
      const res = await upload("notes.bin", doc, { provider: id });
      return { step, status: res.status };
    });
    expect(seen).toEqual([]);
    expect(result.status).toBe(200);
    const p = result.step.provider;
    expect(p).toMatchObject({ kind: "rclone", backend: "webdav", detail: "WebDAV · Oraknid/" });
    const listing = await api.cloud.list({ path: "" });
    expect(listing.errors).toEqual([]);
    expect(listing.entries.find((e) => e.name === "notes.bin")).toMatchObject({
      size: doc.length,
      providerId: p?.id,
    });
    const link = await api.cloud.downloadLink({ providerId: p?.id as string, path: "notes.bin" });
    expect(sha(await download(link.url))).toBe(sha(doc));
    expect(await leaks(password)).toBe(0);
  }, 180_000);
});
