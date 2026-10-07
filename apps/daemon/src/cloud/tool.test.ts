import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type McpDeclaration } from "@oraknid/core";
import { afterEach, describe, expect, it } from "vitest";
import { rigDaemon } from "../testing/backup-rig.ts";
import { testRclone } from "../testing/cloud-rig.ts";
import { seedJob } from "../testing/fixtures.ts";
import { STORAGE_TOOL, storageCall } from "./tool.ts";

// The storage tool (ADR-046): my cloud storage for a job whose skill asks
// for it, through the broker, with a real rclone against its own WebDAV
// server started here (no account, no container).

const skip = testRclone
  ? null
  : "rclone isn't installed here: the storage tool's tests are skipped.";
if (skip) console.warn(skip);

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function rig() {
  const served = mkdtempSync(join(tmpdir(), "oraknid-storage-dav-"));
  closing.push(() => rmSync(served, { recursive: true, force: true }));
  const port = await freePort();
  const server: ChildProcess = spawn(
    testRclone as string,
    ["--config", "/dev/null", "serve", "webdav", served, "--addr", `127.0.0.1:${port}`],
    {
      env: { PATH: process.env.PATH ?? "", RCLONE_USER: "u", RCLONE_PASS: "dav-pass-1234" },
      stdio: "ignore",
    },
  );
  closing.push(() => server.kill("SIGTERM"));
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/`, { method: "PROPFIND" })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await rigDaemon({ rclone: () => testRclone });
  closing.push(() => r.daemon.close());
  closing.push(() => rmSync(r.dir, { recursive: true, force: true }));
  // No provider, no storage tool.
  expect((await r.api.tools.list()).some((t) => t.name === "storage")).toBe(false);
  const step = await r.api.cloud.addRclone({
    name: "My WebDAV",
    backend: "webdav",
    options: {
      url: `http://127.0.0.1:${port}/`,
      vendor: "rclone",
      user: "u",
      pass: "dav-pass-1234",
    },
    folder: "Oraknid",
    unlimited: true,
  });
  const providerId = step.provider?.id as string;
  const work = mkdtempSync(join(tmpdir(), "oraknid-storage-job-"));
  closing.push(() => rmSync(work, { recursive: true, force: true }));
  const jobId = seedJob(r.daemon.db, "running", work);
  return { ...r, served, providerId, work, jobId };
}

describe.skipIf(!!skip)("the storage tool (ADR-046)", () => {
  it("lists, uploads a file of the job, downloads into the job's folder, and stays inside it", async () => {
    const { api, daemon, served, providerId, work, jobId } = await rig();
    // Offered once a provider is there, as one of Oraknid's own.
    const tool = (await api.tools.list()).find((t) => t.name === "storage");
    expect(tool).toMatchObject({ builtIn: true, reads: ["list", "download"], untrusted: true });
    const d = { db: daemon.db, cloud: daemon.cloud };
    const call = (name: string, a: Record<string, unknown>) => storageCall(d, jobId, name, a);

    mkdirSync(join(work, "dist"));
    writeFileSync(join(work, "dist", "report.txt"), "The report.\n");
    const up = await call("upload", {
      file: "dist/report.txt",
      folder: "reports",
      provider: providerId,
    });
    expect(up).toBe("Uploaded dist/report.txt to reports/report.txt in My WebDAV (12 B).");
    expect(readFileSync(join(served, "Oraknid", "reports", "report.txt"), "utf8")).toBe(
      "The report.\n",
    );
    const listing = await call("list", { path: "reports" });
    expect(listing).toContain(`- reports/report.txt: 12 B, in My WebDAV (provider ${providerId})`);
    expect(await call("list", { query: "report" })).toContain("reports/report.txt");

    const down = await call("download", { path: "reports/report.txt", to: "in/copy.txt" });
    expect(down).toBe("Downloaded reports/report.txt from My WebDAV to in/copy.txt.");
    expect(readFileSync(join(work, "in", "copy.txt"), "utf8")).toBe("The report.\n");
    // Never over a file, nor out of the job's folder, nor Git's or a hidden one.
    await expect(
      call("download", { path: "reports/report.txt", to: "in/copy.txt" }),
    ).rejects.toThrow(/exists already/);
    await expect(
      call("download", { path: "reports/report.txt", to: "../out.txt" }),
    ).rejects.toThrow(/outside the job's folder/);
    await expect(call("upload", { file: "/etc/hostname" })).rejects.toThrow(/relative/);
    mkdirSync(join(work, ".git"));
    writeFileSync(join(work, ".git", "config"), "[core]\n");
    await expect(call("upload", { file: ".git/config" })).rejects.toThrow(/hidden/);
    symlinkSync("/etc/hostname", join(work, "escape"));
    await expect(call("upload", { file: "escape" })).rejects.toThrow(/leads outside/);
    expect(existsSync(join(served, "Oraknid", "escape"))).toBe(false);
    await expect(call("download", { path: "nope.txt" })).rejects.toThrow(/No file nope.txt/);

    // WebDAV makes no public links: said in words.
    await expect(call("share_link", { path: "reports/report.txt" })).rejects.toThrow(
      /doesn't make public links|couldn't make a link/,
    );
  }, 60_000);

  it("is judged like any tool: reads pass, an upload is a write, a public link always asks", () => {
    expect(STORAGE_TOOL.judge?.({ jobId: null }, "share_link", {})).toBe("send");
    expect(STORAGE_TOOL.judge?.({ jobId: null }, "upload", {})).toBeUndefined();
    const policy = {
      worktree: "/tmp",
      autonomy: "auto" as const,
      waived: new Set<never>(),
      mcp: new Map<string, McpDeclaration>([
        ["mcp__storage__list", "read"],
        ["mcp__storage__download", "read"],
        ["mcp__storage__share_link", "send"],
      ]),
    };
    const verdict = (tool: string, autonomy: "auto" | "careful" = "auto") =>
      decide({ tool, command: null, path: null }, { ...policy, autonomy }).verdict;
    expect(verdict("mcp__storage__list")).toBe("allow");
    expect(verdict("mcp__storage__download")).toBe("allow");
    expect(verdict("mcp__storage__share_link")).toBe("ask");
    expect(verdict("mcp__storage__upload", "careful")).toBe("ask");
  });
});
