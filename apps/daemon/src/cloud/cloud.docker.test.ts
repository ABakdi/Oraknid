import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { BackupRunView, CloudTransfer, NewCloudProvider } from "@oraknid/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { removeContainers, rigDaemon, settle, watchArgv } from "../testing/backup-rig.ts";
import { cloudSkip, minio, testRclone } from "../testing/cloud-rig.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { CONFIG_PASSWORD } from "./service.ts";

// Cloud storage against a real MinIO (ADR-046), in a throwaway unprivileged
// container, through a real rclone: providers, the pool, placement, the
// upload and download routes, and backups kept there. Skipped, saying so,
// where rclone or Docker isn't available.

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});
afterAll(removeContainers, 120_000);

const MB = 1_000_000;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
};

describe.skipIf(!!cloudSkip)("cloud storage against MinIO (ADR-046)", () => {
  let m: Awaited<ReturnType<typeof minio>>;
  beforeAll(async () => {
    m = await minio();
  }, 180_000);

  const s3 = (bucket: string, name: string, extra: Partial<NewCloudProvider> = {}) =>
    ({
      kind: "s3",
      name,
      preset: "Minio",
      endpoint: m.endpoint,
      region: "us-east-1",
      bucket,
      accessKeyId: m.user,
      secretAccessKey: m.password,
      folder: "",
      limitBytes: null,
      unlimited: false,
      ...extra,
    }) as NewCloudProvider;

  async function setup() {
    const r = await rigDaemon({ rclone: () => testRclone });
    closing.push(() => r.daemon.close());
    const auth = { authorization: `Bearer ${r.daemon.cliToken}` };
    const upload = (
      name: string,
      body: Buffer,
      q: Record<string, string> = {},
      size = body.length,
    ) =>
      fetch(
        `${r.daemon.url}/api/cloud/upload?${new URLSearchParams({ name, size: String(size), ...q })}`,
        { method: "POST", headers: auth, body },
      );
    const download = async (url: string) => {
      const res = await fetch(`${r.daemon.url}${url}`);
      return {
        status: res.status,
        body: Buffer.from(await res.arrayBuffer()),
        headers: res.headers,
      };
    };
    return { ...r, upload, download };
  }

  const bucket = () => `b-${Math.random().toString(36).slice(2, 10)}`;

  it("adds MinIO with its secret kept out of every command line, event and view; the config can't be read without the keychain", async () => {
    const { api, daemon, dir } = await setup();
    // A wrong secret: refused, nothing kept, the secret not in the words.
    const wrong = `wrong-${m.password}`;
    const refused = await api.cloud
      .addProvider(s3(bucket(), "Bad", { secretAccessKey: wrong }))
      .catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/didn't answer/);
    expect((refused as Error).message).not.toContain(wrong);
    expect(await api.cloud.providers()).toEqual([]);

    const {
      result: p,
      seen,
      looks,
    } = await watchArgv(m.password, async () => {
      const added = await api.cloud.addProvider(s3(bucket(), "MinIO", { limitBytes: 50 * MB }));
      await api.cloud.list({ path: "" });
      await api.cloud.checkProvider({ id: added.id });
      return added;
    });
    expect(looks).toBeGreaterThan(5);
    expect(seen).toEqual([]);
    expect(p).toMatchObject({
      kind: "s3",
      preset: "Minio",
      space: "limit",
      usedBytes: 0,
      freeBytes: 50 * MB,
      error: null,
    });
    expect(p.detail).toMatch(/^MinIO · bucket b-/);
    for (const s of [m.password, m.user]) {
      expect(JSON.stringify(await api.cloud.providers())).not.toContain(s);
      expect(
        JSON.stringify(daemon.db.$client.prepare("select type, payload from events").all()),
      ).not.toContain(s);
      expect(
        JSON.stringify(daemon.db.$client.prepare("select * from cloud_providers").all()),
      ).not.toContain(s);
    }

    // The config: encrypted on disk, only mine; rclone can't read it without the keychain's password.
    const file = join(dir, "cloud", "rclone.conf");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(m.password);
    expect(raw).not.toContain(m.user);
    expect(raw).not.toContain("s3");
    expect((spawnSync("stat", ["-c", "%a", file], { encoding: "utf8" }).stdout ?? "").trim()).toBe(
      "600",
    );
    const without = spawnSync(
      testRclone as string,
      ["--config", file, "--ask-password=false", "listremotes"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(without.status).not.toBe(0);
    expect(without.stderr).toMatch(/unable to decrypt|RCLONE_CONFIG_PASS/);
    const withPass = spawnSync(
      testRclone as string,
      ["--config", file, "--ask-password=false", "listremotes"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          RCLONE_CONFIG_PASS: daemon.secrets
            ? ((await daemon.secrets.get(CONFIG_PASSWORD)) ?? "")
            : "",
        },
      },
    );
    expect(withPass.status).toBe(0);
    expect(withPass.stdout.trim()).toBe(`o-${p.id.toLowerCase()}:`);
  }, 120_000);

  it("uploads with progress on the live socket, lists, searches, downloads, renames, moves across providers and deletes", async () => {
    const { api, daemon, upload, download } = await setup();
    const a = await api.cloud.addProvider(s3(bucket(), "Big", { limitBytes: 50 * MB }));
    const b = await api.cloud.addProvider(s3(bucket(), "Small", { limitBytes: 20 * MB }));

    // The live socket, as the web page listens.
    const frames: CloudTransfer[] = [];
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/live?token=${daemon.cliToken}`);
    closing.push(() => ws.close());
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", topics: ["storage"] }));
    ws.on("message", (d) => {
      const f = JSON.parse(String(d)) as { type: string; transfer?: CloudTransfer };
      if (f.type === "transfer" && f.transfer) frames.push(f.transfer);
    });
    await new Promise((r) => setTimeout(r, 200));

    const report = bytes(6 * MB);
    const { result: res, seen } = await watchArgv(m.password, async () => {
      const r = await upload("report.bin", report, { folder: "docs", transfer: "t-1" });
      return { status: r.status, json: (await r.json()) as { providerId: string; path: string } };
    });
    expect(seen).toEqual([]);
    expect(res.status).toBe(200);
    // Most room: Big.
    expect(res.json).toMatchObject({ providerId: a.id, path: "docs/report.bin" });
    await new Promise((r) => setTimeout(r, 300));
    const mine = frames.filter((f) => f.id === "t-1");
    expect(mine.some((f) => f.phase === "send")).toBe(true);
    expect(mine.at(-1)).toMatchObject({ phase: "done", bytes: report.length, providerId: a.id });
    // Nothing left in the way-station folder.
    expect(readdirSync(join(daemon.cloud.tmpDir()))).toEqual([]);

    // The same name again: asked first; into the other provider, chosen.
    expect((await upload("report.bin", report, { folder: "docs" })).status).toBe(409);
    const other = bytes(1 * MB, 2);
    expect((await upload("report.bin", other, { folder: "docs", provider: b.id })).status).toBe(
      200,
    );
    expect((await upload("notes.txt", Buffer.from("hello pool"), { folder: "" })).status).toBe(200);

    // One listing: the folder once, held by both; each file with its provider.
    const root = await api.cloud.list({ path: "" });
    expect(root.errors).toEqual([]);
    const docs = root.entries.find((e) => e.isDir && e.name === "docs");
    expect(docs?.providers.sort()).toEqual([a.id, b.id].sort());
    expect(root.entries.find((e) => e.name === "notes.txt")?.providerId).toBe(a.id);
    const inDocs = await api.cloud.list({ path: "docs" });
    expect(inDocs.entries.map((e) => [e.name, e.providerId, e.size])).toEqual(
      expect.arrayContaining([
        ["report.bin", a.id, report.length],
        ["report.bin", b.id, other.length],
      ]),
    );
    const found = await api.cloud.search({ q: "REPORT", path: "" });
    expect(found.entries.map((e) => e.path)).toEqual(["docs/report.bin", "docs/report.bin"]);
    expect((await api.cloud.providers()).find((p) => p.id === a.id)?.usedBytes).toBeGreaterThan(
      report.length,
    );

    // Download: streamed, once.
    const link = await api.cloud.downloadLink({ providerId: a.id, path: "docs/report.bin" });
    const got = await download(link.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toMatch(/attachment; filename="report.bin"/);
    expect(sha(got.body)).toBe(sha(report));
    expect((await download(link.url)).status).toBe(404);

    // Renamed in its provider; then moved to the other one.
    await api.cloud.move({ providerId: a.id, path: "docs/report.bin", toPath: "docs/q3.bin" });
    await expect(
      api.cloud.move({
        providerId: a.id,
        path: "docs/q3.bin",
        toPath: "docs/report.bin",
        toProviderId: b.id,
      }),
    ).rejects.toThrow(/already/);
    await api.cloud.move({
      providerId: a.id,
      path: "docs/q3.bin",
      toPath: "archive/q3.bin",
      toProviderId: b.id,
    });
    const archive = await api.cloud.list({ path: "archive" });
    expect(archive.entries.map((e) => [e.name, e.providerId])).toEqual([["q3.bin", b.id]]);
    const back = await download(
      (await api.cloud.downloadLink({ providerId: b.id, path: "archive/q3.bin" })).url,
    );
    expect(sha(back.body)).toBe(sha(report));

    // A folder renamed in every provider holding it, then deleted with what's in it.
    await api.cloud.moveFolder({ path: "docs", toPath: "papers" });
    expect((await api.cloud.list({ path: "" })).entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(["papers", "archive", "notes.txt"]),
    );
    expect((await api.cloud.list({ path: "papers" })).entries).toHaveLength(1);
    await api.cloud.deleteFile({ providerId: a.id, path: "notes.txt" });
    await api.cloud.deleteFolder({ path: "papers" });
    expect((await api.cloud.list({ path: "" })).entries.map((e) => e.name)).toEqual(["archive"]);
    await expect(api.cloud.deleteFolder({ path: "" })).rejects.toThrow(/pool itself/);
  }, 180_000);

  it("places by the rule I set; a file too big for any one place is refused before a byte is sent", async () => {
    const { api, daemon, upload } = await setup();
    const a = await api.cloud.addProvider(s3(bucket(), "A", { limitBytes: 30 * MB }));
    const b = await api.cloud.addProvider(s3(bucket(), "B", { limitBytes: 10 * MB }));
    const c = await api.cloud.addProvider(s3(bucket(), "C"));
    expect(c).toMatchObject({ space: "unknown", freeBytes: null });

    expect(await api.cloud.place({ size: MB })).toEqual({ providerId: a.id, refused: null });
    // The priority order: B first while it fits, else A.
    await api.cloud.reorder({ ids: [b.id, a.id, c.id] });
    await api.cloud.setPlacement({
      mode: "auto",
      rule: "priority",
      providerId: null,
      largeFromBytes: 100 * MB,
    });
    expect((await api.cloud.place({ size: MB })).providerId).toBe(b.id);
    expect((await api.cloud.place({ size: 15 * MB })).providerId).toBe(a.id);
    // Too big for any one place, though 40 MB are free in all: refused, never split.
    const big = await api.cloud.place({ size: 35 * MB });
    expect(big.providerId).toBeNull();
    expect(big.refused).toMatch(/Too big for any one place.*never split/);
    const res = await upload("huge.iso", Buffer.alloc(0), {}, 35 * MB);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Too big/);
    expect(readdirSync(daemon.cloud.tmpDir())).toEqual([]);
    // C can't tell its room: only when I pick it, and then it takes it.
    expect((await api.cloud.place({ size: 35 * MB, providerId: c.id })).providerId).toBe(c.id);
    // Pay as you go: never full, so it has the most room.
    await api.cloud.updateProvider({ id: c.id, unlimited: true });
    await api.cloud.setPlacement({
      mode: "auto",
      rule: "free",
      providerId: null,
      largeFromBytes: 100 * MB,
    });
    expect((await api.cloud.place({ size: 35 * MB })).providerId).toBe(c.id);
    // One provider for everything; it says when it's full.
    await api.cloud.setPlacement({
      mode: "provider",
      rule: "free",
      providerId: b.id,
      largeFromBytes: 100 * MB,
    });
    expect((await api.cloud.place({ size: MB })).providerId).toBe(b.id);
    expect((await api.cloud.place({ size: 11 * MB })).refused).toMatch(/doesn't fit in B/);
    // A limit counts what is there: 6 MB in B leaves 4.
    expect((await upload("six.bin", bytes(6 * MB))).status).toBe(200);
    expect((await api.cloud.checkProvider({ id: b.id })).freeBytes).toBe(4 * MB);
    expect((await api.cloud.place({ size: 5 * MB })).refused).toMatch(/doesn't fit in B/);
  }, 180_000);

  it("keeps backups in the pool and in one provider: retention, Verify, a download as stored or decrypted", async () => {
    const ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const { api, daemon, download } = await setup();
    const server = await api.servers.add({
      name: "box",
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      password: "pw",
    });
    const db = join(mkdtempSync(join(tmpdir(), "oraknid-sqlite-")), "shop.db");
    execFileSync("sqlite3", [
      db,
      "create table items(id integer primary key, name text); insert into items(name) values ('violin');",
    ]);
    const a = await api.cloud.addProvider(s3(bucket(), "Pool A", { limitBytes: 50 * MB }));
    const b = await api.cloud.addProvider(s3(bucket(), "Pool B", { limitBytes: 5 * MB }));
    const key = await api.backups.createKey({ name: "k" });
    const target = {
      serverId: server.id,
      kind: "sqlite" as const,
      container: null,
      host: null,
      port: null,
      database: null,
      user: null,
      path: db,
    };
    const plan = await api.backups.createPlan({
      name: "Shop",
      target,
      schedule: { kind: "daily", at: "03:30" },
      destination: { kind: "cloud", providerId: null, folder: "Oraknid backups" },
      retention: { count: 2, days: null },
      keyId: key.id,
      enabled: true,
    });
    const runs: BackupRunView[] = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await settle(api, (await api.backups.run({ id: plan.id })).runId));
      await daemon.backups.settled();
      await new Promise((r) => setTimeout(r, 1100));
    }
    for (const r of runs)
      expect(r).toMatchObject({ state: "ok", location: "cloud storage, Pool A", error: null });
    expect(runs[2]?.path).toMatch(
      /^Oraknid backups\/shop-[a-z0-9]+\/\d{8}-\d{6}-shop-db\.sqlite\.zst\.age$/,
    );
    // Count 2: the oldest went from MinIO too.
    const all = await api.backups.runs({ planId: plan.id });
    expect(all.filter((r) => r.prunedAt).map((r) => r.id)).toEqual([runs[0]?.id]);
    const folder = String(runs[2]?.path).split("/").slice(0, -1).join("/");
    expect((await api.cloud.list({ path: folder })).entries.map((e) => e.path).sort()).toEqual(
      [runs[1]?.path, runs[2]?.path].sort(),
    );
    // Verify: brought back into a temporary file, decrypted, read.
    const v = await api.backups.verify({ runId: runs[2]?.id as string });
    expect(v).toMatchObject({ verifyOk: true });
    expect(v.verifyNote).toMatch(/SQLite database, complete/);

    // Downloaded as stored (the checksum it was made with), and decrypted with its key.
    const stored = await download(
      (await api.backups.downloadLink({ runId: runs[2]?.id as string })).url,
    );
    expect(stored.status).toBe(200);
    expect(stored.body.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(sha(stored.body)).toBe(runs[2]?.checksum);
    const plain = await download(
      (await api.backups.downloadLink({ runId: runs[2]?.id as string, decrypt: true })).url,
    );
    expect(plain.headers.get("content-disposition")).toMatch(/\.sqlite\.zst"/);
    expect(zstdDecompressSync(plain.body).subarray(0, 15).toString()).toBe("SQLite format 3");
    await expect(api.backups.downloadLink({ runId: runs[0]?.id as string })).rejects.toThrow(
      /isn't kept/,
    );

    // To one provider I pick.
    await api.backups.updatePlan({
      id: plan.id,
      destination: { kind: "cloud", providerId: b.id, folder: "db" },
    });
    const one = await settle(api, (await api.backups.run({ id: plan.id })).runId);
    // Retention runs once the backup is kept: waited for.
    await daemon.backups.settled();
    expect(one).toMatchObject({ state: "ok", location: "cloud storage, Pool B" });
    expect((await api.backups.verify({ runId: one.id })).verifyOk).toBe(true);
    // In use: it stays.
    await expect(api.cloud.removeProvider({ id: b.id })).rejects.toThrow(/keeps its backups there/);
    // A kept backup in A (retention took the older one, wherever it was).
    await expect(api.cloud.removeProvider({ id: a.id })).rejects.toThrow(
      /1 kept backup is there: without it it can't be restored/,
    );
    // The plan gone with its backups: gone from MinIO.
    await api.backups.removePlan({ id: plan.id, deleteBackups: true });
    expect((await api.cloud.list({ path: folder })).entries).toEqual([]);
    expect((await api.cloud.list({ path: "db" })).entries).toEqual([]);
    await api.cloud.removeProvider({ id: b.id });
  }, 240_000);
});
