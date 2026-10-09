import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Event } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { reviewNotes, reviews as reviewsTable } from "../db/schema.ts";
import { ATTACHED_TO_REVIEW } from "../eye/talk.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { readsAsFeedback } from "./feedback.ts";
import { designFile, designIndex, injectInto, OVERLAY_TAG, reviewKeyOf } from "./frame.ts";
import { OVERLAY_JS, OVERLAY_PATH } from "./overlay.ts";

// Reviews (ADR-064, M16.1): the API and its rounds, the frame's own origin
// (a design's folder and nothing outside it; the job's app on its port and
// no other), the overlay in HTML only, the chat's notes, and away from home.

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

const PIN = "739204";
const SHOT = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-reviews-"));
  const d: Daemon = await startDaemon({
    paths: resolvePaths({
      ORAKNID_DATA_DIR: join(dir, "data"),
      ORAKNID_CONFIG_DIR: join(dir, "data"),
    }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
    webDir: null,
    ciWatch: false,
    naming: { backfillDelayMs: -1 },
  });
  closing.push(() => d.close());
  const client = (headers: Record<string, string> = {}) =>
    createORPCClient<RouterClient<Router>>(new RPCLink({ url: `${d.url}/api`, headers }));
  const cli = client({ authorization: `Bearer ${d.cliToken}` });
  // The project: a design folder inside it, a secret beside it, and a folder outside it.
  const project = join(dir, "project");
  mkdirSync(join(project, "design", "css"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), "[core]");
  writeFileSync(
    join(project, "design", "index.html"),
    '<!doctype html><html><head><title>Keys</title><link rel="stylesheet" href="css/site.css"></head><body><button id="play">Play</button><img src="logo.svg"></body></html>',
  );
  writeFileSync(
    join(project, "design", "css", "site.css"),
    "body { background: url(../logo.svg); }",
  );
  writeFileSync(join(project, "design", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(project, "design", ".env"), "SECRET=1");
  writeFileSync(join(project, "secret.txt"), "beside the design");
  const outside = join(dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "passwd"), "not yours");
  symlinkSync(outside, join(project, "design", "escape"));
  const jobId = seedJob(d.db, "running", project);
  const events: Event[] = [];
  closing.push(d.bus.subscribe((e) => events.push(e)));
  return { d, dir, cli, client, project, outside, jobId, events };
}

/** A GET (or another method) to the daemon, with a Host of my choosing. */
function get(
  port: number,
  path: string,
  host: string,
  o: { method?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const keyOf = (d: Daemon, id: string) =>
  d.db.select().from(reviewsTable).where(eq(reviewsTable.id, id)).get()?.frameKey ?? "";

describe("reviews through the API (ADR-064)", () => {
  it("opens a design review: an inbox item, review.opened for the pages, a frame URL", async () => {
    const { d, cli, jobId, events, project } = await start();
    const opened = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    expect(opened).toMatchObject({ url: `/review/${opened.id}`, round: 1 });
    const e = events.find((x) => x.type === "review.opened");
    expect(e).toMatchObject({ topic: "inbox", jobId });
    expect(e?.payload).toMatchObject({
      id: opened.id,
      kind: "design",
      url: `/review/${opened.id}`,
    });
    const r = await cli.reviews.get({ id: opened.id });
    expect(r).toMatchObject({ state: "open", round: 1, kind: "design", noteCount: 0, notes: [] });
    expect(r.frameUrl).toBe(`http://rv-${keyOf(d, opened.id)}.localhost:${d.port}/`);
    const items = await cli.inbox.list({ state: "open" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reviewId: opened.id,
      title: "A design is ready for your review",
    });
    // Opened again while it waits: the same review.
    const again = await cli.reviews.open({ jobId, kind: "design", target: "design" });
    expect(again.id).toBe(opened.id);
    expect(await cli.reviews.list({ jobId })).toHaveLength(1);
  });

  it("refuses a design outside the project, and an app on Oraknid's own or a low port", async () => {
    const { d, cli, jobId, outside } = await start();
    await expect(cli.reviews.open({ jobId, kind: "design", target: outside })).rejects.toThrow(
      /inside its project/,
    );
    await expect(cli.reviews.open({ jobId, kind: "design", target: "../outside" })).rejects.toThrow(
      /inside its project/,
    );
    // A symlink inside the project that leads out of it is out of it.
    await expect(
      cli.reviews.open({ jobId, kind: "design", target: "design/escape" }),
    ).rejects.toThrow(/inside its project/);
    await expect(cli.reviews.open({ jobId, kind: "app", target: d.port })).rejects.toThrow(
      /Oraknid's own port/,
    );
    await expect(cli.reviews.open({ jobId, kind: "app", target: 22 })).rejects.toThrow(/between/);
    await expect(
      cli.reviews.open({ jobId, kind: "app", target: "http://example.com:8080" }),
    ).rejects.toThrow(/this computer only/);
  });

  it("keeps notes per round: add with a screenshot, edit, delete, send, the next round, approve", async () => {
    const { d, dir, cli, jobId, events, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    const phone = { name: "Phone", width: 390, height: 844, orientation: "portrait" as const };
    const a = await cli.reviews.notes.add({
      reviewId: id,
      kind: "change",
      text: "The play button is too small",
      device: phone,
      element: {
        selector: "#play",
        text: "Play",
        tag: "button",
        box: { x: 1, y: 2, width: 30, height: 20 },
      },
      page: "/",
      screenshot: SHOT,
    });
    expect(a).toMatchObject({ round: 1, kind: "change", hasScreenshot: true, source: "page" });
    const files = readdirSync(join(dir, "data", "reviews", id));
    expect(files).toEqual([`${a.id}.png`]);
    expect((await cli.reviews.notes.screenshot({ id: a.id })).dataUrl).toBe(SHOT);
    const b = await cli.reviews.notes.add({
      reviewId: id,
      kind: "keep",
      text: "I like the palette",
      device: phone,
      element: null,
    });
    await cli.reviews.notes.edit({ id: b.id, text: "I love the palette" });
    const gone = await cli.reviews.notes.add({
      reviewId: id,
      kind: "general",
      text: "never mind",
      device: null,
      element: null,
      screenshot: SHOT,
    });
    await cli.reviews.notes.delete({ id: gone.id });
    expect(existsSync(join(dir, "data", "reviews", id, `${gone.id}.png`))).toBe(false);
    let r = await cli.reviews.get({ id });
    expect(r.notes.map((n) => n.text)).toEqual([
      "The play button is too small",
      "I love the palette",
    ]);
    expect(r.noteCount).toBe(2);
    expect(events.filter((e) => e.type.startsWith("review.note-")).map((e) => e.type)).toEqual([
      "review.note-added",
      "review.note-added",
      "review.note-edited",
      "review.note-added",
      "review.note-deleted",
    ]);

    // Send notes ends the round; The Eye reads the notes in the event.
    expect(await cli.reviews.sendNotes({ id })).toEqual({ round: 1, notes: 2 });
    const sent = events.find((e) => e.type === "review.notes-sent");
    expect(sent).toMatchObject({ topic: `job:${jobId}`, jobId, actor: "owner" });
    const payload = sent?.payload as { notes: { text: string; device: string }[] } | undefined;
    expect(payload?.notes[0]).toMatchObject({
      text: "The play button is too small",
      device: "Phone 390×844",
    });
    expect(await cli.inbox.list({ state: "open" })).toEqual([]);
    // The round ended: its notes stay as they were.
    await expect(cli.reviews.notes.edit({ id: a.id, text: "x" })).rejects.toThrow(
      /round has ended/,
    );
    await expect(cli.reviews.approve({ id })).rejects.toThrow(/isn't open/);

    // The next round, opened by the harness once the work is ready.
    const next = await cli.reviews.open({ jobId, kind: "design", target: join(project, "design") });
    expect(next).toMatchObject({ id, round: 2 });
    r = await cli.reviews.get({ id });
    expect(r).toMatchObject({ state: "open", round: 2, noteCount: 0 });
    expect(r.notes).toHaveLength(2);
    await expect(cli.reviews.sendNotes({ id })).rejects.toThrow(/No notes/);
    await cli.reviews.approve({ id });
    expect(events.find((e) => e.type === "review.approved")).toMatchObject({
      topic: `job:${jobId}`,
    });
    expect((await cli.reviews.get({ id })).state).toBe("approved");
    // Approved stays approved.
    await cli.reviews.withdraw({ id });
    expect((await cli.reviews.get({ id })).state).toBe("approved");
    expect(d.db.select().from(reviewNotes).all()).toHaveLength(3);
  });

  it("withdraws a job's reviews when it ends", async () => {
    const { d, cli, jobId, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    d.reviews.withdrawJob(jobId);
    expect((await cli.reviews.get({ id })).state).toBe("withdrawn");
    expect(await cli.inbox.list({ state: "open" })).toEqual([]);
  });

  it("attaches feedback written in the project's chat to its one open review", async () => {
    const { d, cli, jobId, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    const projectId = (await cli.jobs.get({ id: jobId })).projectId;
    await cli.projects.talk({ id: projectId, text: "The knobs are too small on the phone" });
    const notes = (await cli.reviews.get({ id })).notes;
    expect(notes).toMatchObject([
      {
        kind: "general",
        source: "chat",
        text: "The knobs are too small on the phone",
        device: null,
      },
    ]);
    const said = (await cli.projects.conversation({ id: projectId })).map((m) => m.text);
    expect(said).toContain(ATTACHED_TO_REVIEW);
    expect(d.reviews.openIn(projectId)).toHaveLength(1);
  });
});

describe("the review's frame (ADR-064)", () => {
  it("serves the design's folder on its own origin, the overlay in its HTML only", async () => {
    const { d, cli, jobId, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    const host = `rv-${keyOf(d, id)}.localhost:${d.port}`;
    const page = await get(d.port, "/", host);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<head>${OVERLAY_TAG}<title>Keys</title>`);
    expect(String(page.headers["content-security-policy"])).toContain(
      `frame-ancestors http://127.0.0.1:${d.port}`,
    );
    expect(page.headers["x-frame-options"]).toBeUndefined();
    const css = await get(d.port, "/css/site.css", host);
    expect(css).toMatchObject({ status: 200, body: "body { background: url(../logo.svg); }" });
    expect(css.headers["content-type"]).toMatch(/text\/css/);
    const overlay = await get(d.port, OVERLAY_PATH, host);
    expect(overlay.body).toBe(OVERLAY_JS);
    // Read only.
    expect((await get(d.port, "/index.html", host, { method: "POST" })).status).toBe(405);
  });

  it("serves nothing outside the design: no .., no dot files, no symlink out, no other key", async () => {
    const { d, cli, jobId, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    const host = `rv-${keyOf(d, id)}.localhost:${d.port}`;
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/css/..%2f..%2fsecret.txt",
      "/.env",
      "/%2eenv",
      "/../.git/config",
      "/escape/passwd",
      "/escape%2fpasswd",
      "/..\\secret.txt",
    ]) {
      const r = await get(d.port, path, host);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toMatch(/beside the design|not yours|SECRET|core/);
    }
    expect(designFile(join(project, "design"), "/%00")).toBeNull();
    // Another key, or the right key on another port: not a review.
    expect((await get(d.port, "/", `rv-${"0".repeat(32)}.localhost:${d.port}`)).status).toBe(404);
    expect(reviewKeyOf(`rv-${keyOf(d, id)}.localhost:1`, d.port)).toBeNull();
    // Withdrawn: nothing.
    await cli.reviews.withdraw({ id });
    expect((await get(d.port, "/", host)).status).toBe(404);
    // Oraknid's own pages and API are not on a review's origin, nor reached through it.
    expect((await get(d.port, "/api/system/status", host)).status).toBe(404);
  });

  it("proxies the job's app on its port only: HTML with the overlay, the rest as it is, websockets", async () => {
    const { d, cli, jobId } = await start();
    const seen: { host?: string; path?: string; origin?: string }[] = [];
    const app: Server = createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url, origin: req.headers.origin });
      if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        res.setHeader("x-frame-options", "DENY");
        res.end("<!doctype html><html><head><title>App</title></head><body>hi</body></html>");
      } else if (req.url === "/gz") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("content-encoding", "gzip");
        res.end(gzipSync("<html><head></head><body>zipped</body></html>"));
      } else if (req.url === "/api/data") {
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      } else {
        res.statusCode = 404;
        res.end("no");
      }
    });
    const wss = new WebSocketServer({ server: app });
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo ${m}`)));
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    closing.push(() => new Promise<void>((r) => app.close(() => r())));
    closing.push(() => wss.close());
    const appPort = (app.address() as { port: number }).port;
    // Another server on this computer the frame must never reach.
    let otherHits = 0;
    const other = createServer((_q, s) => {
      otherHits++;
      s.end("other");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    closing.push(() => new Promise<void>((r) => other.close(() => r())));
    const otherPort = (other.address() as { port: number }).port;

    const { id } = await cli.reviews.open({
      jobId,
      kind: "app",
      target: `http://127.0.0.1:${appPort}`,
    });
    expect((await cli.reviews.get({ id })).target).toBe(`http://127.0.0.1:${appPort}`);
    const host = `rv-${keyOf(d, id)}.localhost:${d.port}`;
    const page = await get(d.port, "/", host, { headers: { origin: `http://${host}` } });
    expect(page.status).toBe(200);
    expect(page.body).toBe(
      `<!doctype html><html><head>${OVERLAY_TAG}<title>App</title></head><body>hi</body></html>`,
    );
    expect(Number(page.headers["content-length"])).toBe(Buffer.byteLength(page.body));
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors");
    expect(seen[0]).toEqual({
      host: `127.0.0.1:${appPort}`,
      path: "/",
      origin: `http://127.0.0.1:${appPort}`,
    });
    const gz = await get(d.port, "/gz", host);
    expect(gz.body).toBe(`<html><head>${OVERLAY_TAG}</head><body>zipped</body></html>`);
    const json = await get(d.port, "/api/data", host);
    expect(json).toMatchObject({ status: 200, body: '{"ok":true}' });
    // An absolute-form request names another port: it still goes to the app's.
    await get(d.port, `http://127.0.0.1:${otherPort}/api/data`, host);
    expect(otherHits).toBe(0);
    // The app's websocket (its HMR), through the frame's origin.
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/hmr`, { headers: { host } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo ping");
    // The app gone: a page that says so and tries again, with the overlay.
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => {
      app.close(() => r());
      app.closeAllConnections();
    });
    const down = await get(d.port, "/", host);
    expect(down.status).toBe(502);
    expect(down.body).toContain(`isn't answering on port ${appPort}`);
    expect(down.body).toContain(OVERLAY_TAG);
  });

  it("adds the overlay at the top of <head>, or of the page", () => {
    expect(injectInto("<html><HEAD lang=x><title>t</title></HEAD></html>", "<s>")).toBe(
      "<html><HEAD lang=x><s><title>t</title></HEAD></html>",
    );
    expect(injectInto("<!doctype html><p>hi", "<s>")).toBe("<!doctype html><s><p>hi");
    expect(injectInto("<p>hi", "<s>")).toBe("<s><p>hi");
  });

  it("the overlay is valid JavaScript", () => {
    expect(() => new Function(OVERLAY_JS)).not.toThrow();
  });
});

describe("away from home (ADR-064, ADR-030)", () => {
  it("reads anywhere; notes, Approve and the frame need full rights; the frame comes inlined", async () => {
    const { d, cli, client, jobId, project } = await start();
    const { id } = await cli.reviews.open({
      jobId,
      kind: "design",
      target: join(project, "design"),
    });
    const pair = async (name: string) => {
      const { code } = await cli.devices.pairStart();
      return (await client().devices.pairComplete({ code, name })).token;
    };
    const as = (tok: string, session?: string, remote = false) =>
      client({
        authorization: `Bearer ${tok}`,
        ...(session ? { "x-oraknid-unlock": session } : {}),
        ...(remote ? { "x-oraknid-remote": "1" } : {}),
      });
    const laptop = await pair("Laptop");
    const { session } = await as(laptop).lock.setPin({ current: null, pin: PIN });
    const phone = await pair("Phone");
    const { session: ps } = await as(phone).lock.unlock({ pin: PIN });
    const away = as(phone, ps, true);
    const r = await away.reviews.get({ id });
    expect(r.frameUrl).toBeNull();
    const note = {
      reviewId: id,
      kind: "general" as const,
      text: "hi",
      device: null,
      element: null,
    };
    await expect(away.reviews.notes.add(note)).rejects.toThrow(/not away from home/);
    await expect(away.reviews.frame({ id })).rejects.toThrow(/not away from home/);
    await expect(away.reviews.approve({ id })).rejects.toThrow(/not away from home/);
    await as(laptop, session).devices.setRights({
      id: d.devices.list().find((x) => x.name === "Phone")?.id ?? "",
      full: true,
      pin: PIN,
    });
    await away.reviews.notes.add(note);
    const frame = await away.reviews.frame({ id });
    expect(frame.path).toBe("/");
    expect(frame.html).toContain("window.__oraknidReview=");
    expect(frame.html).toContain("oraknid-review");
    // The stylesheet and the images inlined, its url() too.
    expect(frame.html).toMatch(/<style>body \{ background: url\("data:image\/svg\+xml;base64,/);
    expect(frame.html).toMatch(/<img src="data:image\/svg\+xml;base64,/);
    expect(frame.missing).toEqual([]);
    await expect(away.reviews.frame({ id, path: "/../secret.txt" })).rejects.toThrow(/No page/);
  });
});

describe("feedback in the chat", () => {
  it("reads words about how it looks as feedback, orders and plain questions not", () => {
    expect(readsAsFeedback("the knobs are too small on the phone")).toBe(true);
    expect(readsAsFeedback("I like the header")).toBe(true);
    expect(readsAsFeedback("make the buttons bigger")).toBe(true);
    expect(readsAsFeedback("stop the job")).toBe(false);
    expect(readsAsFeedback("cancel, the layout is wrong")).toBe(false);
    expect(readsAsFeedback("how far along are you?")).toBe(false);
  });
});

describe("a design without index.html (2026-10-09, the Keys design)", () => {
  it("lists its screens instead of 'Not in the design', and picks the one that fits the size", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-design-"));
    for (const f of ["desktop.html", "phone-landscape.html", "phone-portrait.html", "styles.css"])
      writeFileSync(join(root, f), "<p>x</p>");
    mkdirSync(join(root, "brand"));
    writeFileSync(join(root, "brand", "index.html"), "<p>logo</p>");
    mkdirSync(join(root, ".git"));
    const page = designIndex(root, "/") ?? "";
    expect(page).toContain('href="desktop.html"');
    expect(page).toContain('href="phone-landscape.html"');
    expect(page).toContain('href="brand/"');
    expect(page).not.toContain("styles.css");
    expect(page).not.toContain(".git");
    expect(page).toContain("phone-landscape");
    // Only folders inside the design, never outside it.
    expect(designIndex(root, "/../")).toBeNull();
    expect(designIndex(root, "/.git/")).toBeNull();
    // A design with an index.html serves it as before.
    writeFileSync(join(root, "index.html"), "<p>home</p>");
    expect(designFile(root, "/")).toBe(join(realpathSync(root), "index.html"));
  });
});
