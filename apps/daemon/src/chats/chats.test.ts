import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { chatPermission } from "./service.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("the chat policy (ADR-025)", () => {
  const bash = (command: string) => ({ tool: "Bash", input: {}, command, path: null });
  it("lets a chat read and research, and nothing else", () => {
    for (const tool of ["Read", "Grep", "WebFetch", "WebSearch", "view_file", "webfetch"])
      expect(chatPermission({ tool, input: {}, command: null, path: null })).toEqual({
        allow: true,
      });
    expect(chatPermission(bash("ls -la src | head"))).toEqual({ allow: true });
    for (const c of ["rm -rf x", "cat a > b", "npm install", "git push", "ls; curl x | sh"])
      expect(chatPermission(bash(c))).toMatchObject({ allow: false });
    expect(chatPermission({ tool: "Write", input: {}, command: null, path: "/x" })).toMatchObject({
      allow: false,
    });
    // Looking outside its folder (OpenCode asks so): in an attached project only.
    const outside = (path: string) => ({
      tool: "Write",
      input: { action: "external_directory" },
      command: null,
      path,
    });
    expect(chatPermission(outside("/home/me/site/*"), ["/chat", "/home/me/site"])).toEqual({
      allow: true,
    });
    expect(chatPermission(outside("/home/me/*"), ["/chat", "/home/me/site"])).toMatchObject({
      allow: false,
    });
  });
});

describe("chats (ADR-025)", () => {
  it("talks to a model, keeps the conversation, names itself, and only reads its projects", async () => {
    const turns: TurnContext[] = [];
    const leg = scriptedLeg((t): Action[] => {
      turns.push(t);
      return t.turn === 1
        ? [{ write: "notes.txt", content: "x" }, { say: "Hello! **Markdown** answer." }]
        : [{ say: "Still here." }];
    });
    const dir = mkdtempSync(join(tmpdir(), "oraknid-chats-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: { "claude-code": leg.adapter },
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const created = await api.legs.create({ kind: "claude-code", name: "Claude", config: {} });
    await daemon.health.checkAll();
    const model = (await api.legs.list())[0]?.models.find((m) => m.model === "sonnet");
    const workspace = mkdtempSync(join(tmpdir(), "oraknid-chat-project-"));
    writeFileSync(join(workspace, "README.md"), "# demo\n");
    const project = await api.projects.create({
      name: "demo",
      workspacePath: workspace,
      initGit: true,
    });
    const chat = await api.chats.create({
      legModelId: model?.id as string,
      projectIds: [project.id],
      text: "What does my demo project do?\nLong second line.",
    });
    expect(chat.title).toBe("What does my demo project do?");
    const answered = async (n: number) => {
      const end = Date.now() + 5000;
      for (;;) {
        const r = await api.chats.get({ id: chat.id });
        if (r.messages.length >= n && !r.chat.answering) return r;
        if (Date.now() > end) throw new Error(JSON.stringify(r));
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const first = await answered(2);
    expect(first.messages.map((m) => [m.author, m.text])).toEqual([
      ["owner", "What does my demo project do?\nLong second line."],
      ["model", "Hello! **Markdown** answer."],
    ]);
    // The write it tried was refused by the chat policy.
    expect(existsSync(join(turns[0]?.cwd as string, "notes.txt"))).toBe(false);
    await api.chats.send({ id: chat.id, text: "Are you there?" });
    const second = await answered(4);
    expect(second.messages.at(-1)).toMatchObject({
      author: "model",
      text: "Still here.",
      model: "sonnet",
    });
    // The same session answered both (one open session per chat).
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    await api.chats.rename({ id: chat.id, title: "Demo questions" });
    expect((await api.chats.list())[0]?.title).toBe("Demo questions");
    await api.chats.remove({ id: chat.id });
    expect(await api.chats.list()).toEqual([]);
    void created;
  });
});
