import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ChatView, NewChat } from "@oraknid/contracts";
import { programsIn } from "@oraknid/core";
import type { LegEvent, PermissionDecision, PermissionRequest } from "@oraknid/leg-sdk";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { chatMessages, chats, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";

// Chats with my models (ADR-025): a Leg session in a folder of its own,
// which may read that folder and the projects I attach, and research the
// web; nothing else. A chat isn't a job: no plan, no checks, no Silk.

type ChatRow = typeof chats.$inferSelect;

/** Tools that only read or research, by the names the Legs use. */
const READS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "view_file",
  "list_dir",
  "grep_search",
  "find_by_name",
  "read_url_content",
  "search_web",
]);

/** Programs a chat may run to look at files: none of them writes. */
const LOOKING = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "file",
  "stat",
  "pwd",
  "echo",
  "tree",
  "sort",
  "uniq",
  "cut",
  "du",
]);

const REFUSED =
  "This chat only reads and researches: it can't change files or run that. To change a project, start a job.";

/**
 * The chat policy (ADR-025), fixed: reading and research, and looking with
 * plain programs. `roots` are the folders it may reach (its own and the
 * attached projects'): an agent asking to look outside its folder (OpenCode's
 * "external directory") may, there and only there; the sandbox keeps them read-only.
 */
export function chatPermission(r: PermissionRequest, roots: string[] = []): PermissionDecision {
  if (READS.has(r.tool)) return { allow: true };
  if ((r.input as { action?: string }).action === "external_directory" && r.path) {
    const path = r.path.replace(/\/\*+$/, "");
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) return { allow: true };
  }
  if (r.command) {
    const programs = programsIn(r.command);
    // No redirection to a file: `>` writes, whatever the program.
    if (
      programs.length &&
      programs.every((p) => LOOKING.has(p)) &&
      !/(^|[^>])>(?!&)/.test(r.command)
    )
      return { allow: true };
  }
  return { allow: false, message: REFUSED };
}

const SYSTEM = `You are talking with the owner of this machine in Oraknid's Chats: answer, explain, research. You may read files in your folder and in any project attached to this chat, and look things up on the web. You can't change files or run anything else: if the owner wants a change made, say so and suggest they start a job. Answer in markdown.`;

interface Open {
  sup: Supervised;
  events: AsyncIterator<LegEvent>;
  idle: NodeJS.Timeout | undefined;
}

export class Chats {
  readonly #open = new Map<string, Open>();
  /** The answer being written, per chat. */
  readonly #answering = new Map<string, string>();

  constructor(
    private readonly o: {
      db: Db;
      bus: EventBus;
      registry: LegRegistry;
      supervisor: LegSupervisor;
      dataDir: string;
      now?: () => number;
      /** How long a chat's session stays open after its last answer. */
      idleMs?: number;
    },
  ) {}

  #now() {
    return this.o.now?.() ?? Date.now();
  }

  #row(id: string): ChatRow {
    const row = this.o.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`No chat ${id}.`);
    return row;
  }

  #view(row: ChatRow): ChatView {
    const model = this.o.registry.model(row.legModelId);
    const leg = this.o.registry.all().find((l) => l.id === row.legId);
    return {
      id: row.id,
      title: row.title,
      legId: row.legId,
      legModelId: row.legModelId,
      modelLabel: `${leg?.name ?? "a removed Leg"} · ${model?.model ?? "?"}`,
      effort: row.effort,
      projectIds: row.projectIds,
      answering: this.#answering.get(row.id) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  list(): ChatView[] {
    return this.o.db
      .select()
      .from(chats)
      .orderBy(desc(chats.updatedAt))
      .all()
      .map((r) => this.#view(r));
  }

  get(id: string): { chat: ChatView; messages: ChatMessage[] } {
    const row = this.#row(id);
    const messages = this.o.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, id))
      .orderBy(asc(chatMessages.at))
      .all()
      .map((m) => ({ ...m }));
    return { chat: this.#view(row), messages };
  }

  create(input: NewChat): ChatView {
    const model = this.o.registry.model(input.legModelId);
    if (!model) throw new Error(`No Leg model ${input.legModelId}.`);
    this.#projects(input.projectIds);
    const id = newId(this.#now());
    const t = this.#now();
    this.o.db
      .insert(chats)
      .values({
        id,
        title: input.text ? titleOf(input.text) : "New chat",
        legId: model.legId,
        legModelId: model.id,
        effort: input.effort,
        projectIds: input.projectIds,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    this.#publish(id, "chat.created", {});
    if (input.text) this.send(id, input.text);
    return this.#view(this.#row(id));
  }

  /** Writes my message and has the model answer it, in the background. */
  send(id: string, text: string) {
    const row = this.#row(id);
    if (this.#answering.has(id)) throw new Error("It is still answering; stop it or wait.");
    const t = this.#now();
    this.o.db
      .insert(chatMessages)
      .values({ id: newId(t), chatId: id, author: "owner", text, model: null, error: null, at: t })
      .run();
    this.o.db
      .update(chats)
      .set({ updatedAt: t, ...(row.title === "New chat" ? { title: titleOf(text) } : {}) })
      .where(eq(chats.id, id))
      .run();
    this.#answering.set(id, "");
    this.#publish(id, "chat.message", { author: "owner" });
    void this.#answer(row, text).catch((error) =>
      this.#finish(id, "", error instanceof Error ? error.message : String(error)),
    );
  }

  async #answer(row: ChatRow, text: string) {
    let open = this.#open.get(row.id);
    if (open) {
      clearTimeout(open.idle);
      await open.sup.session.send(text);
    } else {
      const cwd = join(this.o.dataDir, "chats", row.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const history = this.#history(row.id);
      const projects = this.#projectRows(row.projectIds);
      const attached = projects.length
        ? `\n\n# Projects attached to this chat (read-only)\n${projects.map((p) => `- ${p.name}: ${p.path}`).join("\n")}`
        : "";
      const sup = await this.o.supervisor.start({
        legId: row.legId,
        legModelId: row.legModelId,
        effort: row.effort,
        jobId: null,
        taskId: null,
        attemptId: `chat:${row.id}`,
        cwd,
        // A Leg that can't resume its own session gets the conversation so far.
        systemPrompt:
          row.nativeSessionId || !history
            ? `${SYSTEM}${attached}`
            : `${SYSTEM}${attached}\n\n# The conversation so far\n${history}`,
        // A resumed session doesn't get the instructions again: what it may read comes with the message.
        prompt: row.nativeSessionId && attached ? `${attached.trim()}\n\n${text}` : text,
        resumeFrom: row.nativeSessionId,
        readonly: projects.map((p) => p.path),
        onPermission: async (r) => chatPermission(r, [cwd, ...projects.map((p) => p.path)]),
      });
      open = { sup, events: sup.events[Symbol.asyncIterator](), idle: undefined };
      this.#open.set(row.id, open);
    }
    let said = "";
    // Text after a tool call starts a new paragraph, not the middle of the last sentence.
    let afterTool = false;
    for (;;) {
      const next = await open.events.next();
      if (next.done) {
        this.#open.delete(row.id);
        return this.#finish(row.id, said, said ? null : "The session ended before answering.");
      }
      const e = next.value;
      if (e.type === "tool.called") afterTool = true;
      if (e.type === "text.delta") {
        said += afterTool && said && !said.endsWith("\n") ? `\n\n${e.text}` : e.text;
        afterTool = false;
        this.#answering.set(row.id, said);
      }
      if (e.type === "turn.ended") {
        const native = open.sup.session.nativeSessionId();
        if (native && native !== row.nativeSessionId)
          this.o.db
            .update(chats)
            .set({ nativeSessionId: native })
            .where(eq(chats.id, row.id))
            .run();
        // What was streamed, with its paragraph breaks; the adapter's text when nothing streamed.
        const reply = said || e.text;
        this.#finish(
          row.id,
          reply,
          e.reason === "completed" || e.reason === "interrupted" ? null : (e.error ?? e.reason),
        );
        // Kept open for the next message a while, then closed: a chat holds no session for long.
        const o = open;
        o.idle = setTimeout(() => this.#close(row.id), this.o.idleMs ?? 10 * 60_000);
        o.idle.unref();
        return;
      }
    }
  }

  #finish(id: string, text: string, error: string | null) {
    const row = this.o.db.select().from(chats).where(eq(chats.id, id)).get();
    this.#answering.delete(id);
    if (!row) return;
    const model = this.o.registry.model(row.legModelId)?.model ?? null;
    const t = this.#now();
    this.o.db
      .insert(chatMessages)
      .values({ id: newId(t), chatId: id, author: "model", text, model, error, at: t })
      .run();
    this.o.db.update(chats).set({ updatedAt: t }).where(eq(chats.id, id)).run();
    this.#publish(id, "chat.message", { author: "model", error });
  }

  /** Ends the answer being written, keeping what was said so far. */
  async stop(id: string) {
    await this.#open.get(id)?.sup.session.interrupt();
  }

  rename(id: string, title: string) {
    this.#row(id);
    this.o.db.update(chats).set({ title }).where(eq(chats.id, id)).run();
    this.#publish(id, "chat.updated", {});
  }

  setProjects(id: string, projectIds: string[]) {
    this.#row(id);
    this.#projects(projectIds);
    this.o.db.update(chats).set({ projectIds }).where(eq(chats.id, id)).run();
    // The next message opens a session that sees them.
    this.#close(id);
    this.#publish(id, "chat.updated", {});
  }

  remove(id: string) {
    this.#row(id);
    this.#close(id);
    this.o.db.delete(chatMessages).where(eq(chatMessages.chatId, id)).run();
    this.o.db.delete(chats).where(eq(chats.id, id)).run();
    rmSync(join(this.o.dataDir, "chats", id), { recursive: true, force: true });
    this.#publish(id, "chat.removed", {});
  }

  stopAll() {
    for (const id of [...this.#open.keys()]) this.#close(id);
  }

  #close(id: string) {
    const open = this.#open.get(id);
    if (!open) return;
    clearTimeout(open.idle);
    this.#open.delete(id);
    void this.o.supervisor.close(open.sup).catch(() => {});
  }

  /** The folders of these projects; unknown ones are refused. */
  #projects(ids: string[]): string[] {
    return this.#projectRows(ids).map((p) => p.path);
  }

  #projectRows(ids: string[]): { name: string; path: string }[] {
    if (!ids.length) return [];
    const rows = this.o.db.select().from(projects).where(inArray(projects.id, ids)).all();
    if (rows.length !== new Set(ids).size) throw new Error("One of those projects doesn't exist.");
    return rows.map((p) => ({ name: p.name, path: p.workspacePath }));
  }

  #history(id: string): string {
    return this.o.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, id))
      .orderBy(asc(chatMessages.at))
      .all()
      .slice(0, -1)
      .slice(-40)
      .map((m) => `**${m.author === "owner" ? "Owner" : "You"}:** ${m.text}`)
      .join("\n\n");
  }

  #publish(id: string, type: string, payload: Record<string, unknown>) {
    // Few and small (never the streamed text): on "overview", so the list and the chat both follow.
    this.o.bus.publish({
      type,
      topic: "overview",
      jobId: null,
      payload: { chatId: id, ...payload },
    });
  }
}

const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
};
