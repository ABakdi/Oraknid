import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { exportAudit, searchAudit } from "./audit.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-audit-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
  });
  return { d: daemon, dir };
}

describe("audit log (BR-16)", () => {
  it("never stores a secret it knows, nor a secret-shaped string", async () => {
    const { d } = await start();
    await d.secrets.set("smtp.password", "correct-horse-battery");
    d.bus.publish({
      type: "test.leak",
      topic: "overview",
      jobId: null,
      payload: { said: "pw is correct-horse-battery, key sk-abcdefghijklmnopqrstu" },
    });
    const [e] = searchAudit(d.db, { type: "test.leak", limit: 1 });
    expect(e?.payload).toEqual({ said: "pw is [secret], key [secret]" });
  });

  it("records who did what, and finds it by actor, type prefix and text", async () => {
    const { d } = await start();
    const job = seedJob(d.db, "running");
    const id = d.inbox.open({
      kind: "question",
      jobId: job,
      raisedBy: "eye",
      title: "Which colour?",
      detail: "",
      options: [],
    });
    d.inbox.answer(id, "Blue, please");
    const mine = searchAudit(d.db, { actor: "owner", limit: 10 });
    expect(mine.map((e) => e.type)).toEqual(["inbox.answered"]);
    expect(searchAudit(d.db, { type: "inbox.", limit: 10 }).map((e) => e.type)).toEqual([
      "inbox.answered",
      "inbox.opened",
    ]);
    expect(searchAudit(d.db, { text: "Blue", limit: 10 }).map((e) => e.type)).toEqual([
      "inbox.answered",
    ]);
    expect(searchAudit(d.db, { jobId: job, limit: 10 })).toHaveLength(2);
  });

  it("exports to one JSONL file per day, each event once", async () => {
    const { d, dir } = await start();
    const out = join(dir, "audit");
    const first = exportAudit(d.db, out);
    expect(first).toBeGreaterThan(0);
    expect(exportAudit(d.db, out)).toBe(0);
    d.bus.publish({ type: "test.more", topic: "overview", jobId: null, payload: null });
    expect(exportAudit(d.db, out)).toBe(1);
    const [file] = readdirSync(out);
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readFileSync(join(out, file as string), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(first + 1);
    expect(lines.at(-1)).toMatchObject({ type: "test.more", actor: "oraknid" });
    expect(existsSync(out)).toBe(true);
  });
});
