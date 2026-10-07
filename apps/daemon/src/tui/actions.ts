import type {
  EyeMessage,
  InboxItem,
  JobView,
  ProjectView,
  Question,
  QuestionAnswer,
  ServerView,
} from "@oraknid/contracts";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../api/router.ts";
import { ciCommand } from "./ci.ts";
import { COMMANDS, findCommand, helpLines } from "./commands.ts";
import type { LiveFeed } from "./live.ts";
import { ansi, renderMarkdown } from "./markdown.ts";
import {
  ago,
  answerOf,
  bytes,
  jobLines,
  jobState,
  type Panel,
  panelKey,
  pickedNumbers,
  planTree,
  questionItems,
  serverLines,
  taskLabel,
  taskLines,
} from "./panels.ts";

// What each slash command does (ADR-055): every one an API procedure the
// web uses too, the terminal adds none of its own.

export type Api = RouterClient<Router>;

export interface AppState {
  project: ProjectView | null;
  server: ServerView | null;
  job: JobView | null;
  /** The prompt talks to the current server's Eye (ADR-049), not the project's. */
  chatServer: boolean;
  /** The lists as last shown, for /project 2, /job 3, /server 1. */
  projects: ProjectView[];
  jobs: JobView[];
  servers: ServerView[];
  messages: EyeMessage[];
}

export interface Ctx {
  api: Api;
  live: LiveFeed;
  get(): AppState;
  set(patch: Partial<AppState>): void;
  push(p: Panel): void;
  /** Replaces the panel on top (the next step of the same thing). */
  replace(p: Panel): void;
  pop(): void;
  closeAll(): void;
  update(key: string, fn: (p: Panel) => Panel): void;
  flash(text: string, tone?: "ok" | "error"): void;
  clearNotice(): void;
  shell(server: ServerView): void;
  quit(): void;
  now(): number;
}

/** The sentence an error carries (BR-17), whatever its shape. */
export function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

/** A procedure this daemon doesn't have (an older one, or one another milestone adds). */
export function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  return e?.code === "NOT_FOUND" || e?.status === 404;
}

/** Picks a project, job or server by its number in the list, or by words in its name. */
export function pickBy<T>(list: T[], arg: string, name: (x: T) => string): T | undefined {
  const a = arg.trim();
  if (/^\d+$/.test(a)) return list[Number(a) - 1];
  const low = a.toLowerCase();
  return (
    list.find((x) => name(x).toLowerCase() === low) ??
    list.find((x) => name(x).toLowerCase().includes(low))
  );
}

export function makeActions(c: Ctx) {
  const needProject = () => {
    const p = c.get().project;
    if (!p) throw new Error("No project chosen: pick one with /projects.");
    return p;
  };
  const needJob = () => {
    const j = c.get().job;
    if (!j) throw new Error("No job chosen: pick one with /jobs.");
    return j;
  };
  const needServer = () => {
    const s = c.get().server;
    if (!s) throw new Error("No server chosen: pick one with /servers.");
    return s;
  };

  // ── projects ─────────────────────────────────────────────────────

  const loadProjects = async () => {
    const list = (await c.api.projects.list()).filter((p) => !p.archivedAt && !p.serverId);
    c.set({ projects: list });
    return list;
  };

  const chooseProject = (p: ProjectView) => {
    c.set({ project: p, job: null, chatServer: false });
    c.closeAll();
    c.flash(`Talking to ${p.name}'s Eye.`, "ok");
  };

  const projects = async () => {
    const list = await loadProjects();
    if (!list.length) {
      c.flash("No projects yet: make one in the web UI, or ask in /chats.", "error");
      return;
    }
    const current = c.get().project?.id;
    c.push({
      key: panelKey("projects"),
      title: "Projects",
      items: list.map((p) => ({
        label: `${p.name}${p.id === current ? ansi.green("  ● current") : ""}`,
        detail: `${p.workspacePath} · ${p.jobCount} job${p.jobCount === 1 ? "" : "s"}`,
      })),
      selected: Math.max(
        0,
        list.findIndex((p) => p.id === current),
      ),
      onPick: (i) => {
        const p = list[i];
        if (p) chooseProject(p);
      },
      hint: "A number or Enter makes it the current project.",
    });
  };

  const project = async (arg: string) => {
    if (!arg) return projects();
    const list = c.get().projects.length ? c.get().projects : await loadProjects();
    const p = pickBy(list, arg, (x) => x.name);
    if (!p) throw new Error(`No project “${arg}”: /projects lists them.`);
    chooseProject(p);
  };

  // ── jobs ─────────────────────────────────────────────────────────

  const jobPanel = async (id: string): Promise<Panel> => {
    const j = await c.api.jobs.get({ id });
    c.set({ job: j });
    const tree = planTree(j.tasks);
    const key = panelKey("job");
    return {
      key,
      title: `Job · ${j.title}`,
      lines: jobLines(j),
      items: tree.map(({ task, depth }) => ({ label: taskLabel(task, depth) })),
      onPick: (i) => {
        const t = tree[i]?.task;
        if (t)
          c.push({
            key: panelKey("task"),
            title: `Task · ${t.title}`,
            lines: taskLines(t),
            anchor: "top",
          });
      },
      topics: [`job:${j.id}`],
      refresh: async () => {
        const p = await jobPanel(j.id);
        return { lines: p.lines ?? [], items: p.items ?? [], onPick: p.onPick };
      },
      hint: "/logs · /pause · /resume · /cancel · /redirect <instruction> · a number opens a task",
    };
  };

  const jobs = async (arg: string) => {
    const all = arg.trim() === "all";
    const p = all ? null : needProject();
    const list = (await c.api.jobs.list(p ? { projectId: p.id } : undefined))
      .filter((j) => j.state !== "draft" || all)
      .reverse();
    c.set({ jobs: list });
    if (!list.length) {
      c.flash(p ? `No jobs in ${p.name} yet: ask its Eye for work.` : "No jobs yet.", "error");
      return;
    }
    c.push({
      key: panelKey("jobs"),
      title: p ? `Jobs · ${p.name}` : "Jobs · every project",
      items: list.map((j) => {
        const done = j.tasks.filter((t) => t.state === "done").length;
        return {
          label: `${j.title}  ${jobState(j.state)}`,
          detail: `${done}/${j.tasks.length} tasks · ${ago(j.createdAt, c.now())}`,
        };
      }),
      onPick: async (i) => {
        const j = list[i];
        if (j) c.push(await jobPanel(j.id));
      },
      topics: ["overview"],
      hint: "A number opens the job.",
    });
  };

  const job = async (arg: string) => {
    if (!arg) {
      const j = c.get().job;
      if (j) return c.push(await jobPanel(j.id));
      return jobs("");
    }
    let list = c.get().jobs;
    if (!list.length) {
      const p = needProject();
      list = (await c.api.jobs.list({ projectId: p.id }))
        .filter((j) => j.state !== "draft")
        .reverse();
      c.set({ jobs: list });
    }
    const j = pickBy(list, arg, (x) => x.title);
    if (!j) throw new Error(`No job “${arg}”: /jobs lists them.`);
    c.push(await jobPanel(j.id));
  };

  const control = async (what: "pause" | "resume") => {
    const j = needJob();
    if (what === "pause") await c.api.jobs.pause({ id: j.id });
    if (what === "resume") await c.api.jobs.resume({ id: j.id });
    c.flash(`${j.title}: ${what === "pause" ? "pausing" : "resumed"}.`, "ok");
  };

  /** "Cancel “…”? y/N": y cancels, anything else keeps it going. */
  const confirmCancel = (j: JobView, how: "push" | "replace" = "push") =>
    c[how]({
      key: panelKey("cancel"),
      title: `Cancel “${j.title}”?`,
      lines: [
        "The work so far stays in its folder; what it asked you is withdrawn.",
        "",
        `${ansi.bold("y")} cancels it · ${ansi.bold("n")} or Esc keeps it going`,
      ],
      anchor: "top",
      hint: "y/N",
      onText: async (answer) => {
        c.pop();
        if (!/^y(es)?$/i.test(answer.trim())) {
          c.flash(`${j.title}: kept going.`, "ok");
          return;
        }
        await c.api.jobs.cancel({ id: j.id, reason: "Cancelled from the terminal app." });
        c.flash(`${j.title}: cancelling.`, "ok");
      },
    });

  /**
   * Cancel (The-Eye → Cancelling from the chat): the chosen job, or, with
   * none chosen, the one this conversation is about (the project's, or the
   * server's after /chat); several going, a list picks which. Always y/N.
   */
  const cancel = async () => {
    const st = c.get();
    const ended = (state: string) => ["draft", "completed", "cancelled", "failed"].includes(state);
    if (st.job && !st.chatServer) {
      const j = await c.api.jobs.get({ id: st.job.id });
      if (ended(j.state)) throw new Error(`${j.title} has ended already.`);
      return confirmCancel(j);
    }
    const pid = st.chatServer ? st.server?.projectId : st.project?.id;
    if (!pid)
      throw new Error("No job to cancel: pick a project with /projects, or a job with /jobs.");
    const going = (await c.api.jobs.list({ projectId: pid }))
      .filter((j) => !ended(j.state))
      .reverse();
    if (!going.length) throw new Error("No job is going in this conversation.");
    if (going.length === 1) return confirmCancel(going[0] as JobView);
    c.push({
      key: panelKey("cancel-which"),
      title: "Cancel which job?",
      items: going.map((j) => ({ label: `${j.title}  ${jobState(j.state)}` })),
      onPick: (i) => {
        const j = going[i];
        if (j) confirmCancel(j, "replace");
      },
      hint: "A number picks the job; then y/N.",
    });
  };

  const redirect = async (arg: string) => {
    const j = needJob();
    if (!arg) throw new Error("Say what it should do instead: /redirect <instruction>.");
    await c.api.jobs.redirect({ id: j.id, instruction: arg });
    c.flash(`${j.title}: redirected.`, "ok");
  };

  // ── logs ─────────────────────────────────────────────────────────

  const sessionLogPanel = async (
    id: string,
    title: string,
    jobId: string | null,
  ): Promise<Panel> => {
    const read = async () => {
      const lines: string[] = [];
      let after = 0;
      for (let i = 0; i < 50; i++) {
        const page = await c.api.sessions.log({ id, after });
        for (const e of page.entries) {
          const head =
            e.kind === "tool"
              ? ansi.dim(`→ ${e.tool ?? "tool"} `)
              : e.kind === "thinking"
                ? ""
                : "";
          for (const l of e.text.split("\n"))
            lines.push(e.kind === "thinking" ? ansi.dim(ansi.italic(l)) : `${head}${l}`);
        }
        if (page.next === after || !page.entries.length) break;
        after = page.next;
      }
      return lines.slice(-2000);
    };
    return {
      key: panelKey("session"),
      title,
      lines: await read(),
      anchor: "bottom",
      ...(jobId
        ? { topics: [`job:${jobId}`], refresh: async () => ({ lines: await read() }) }
        : {}),
    };
  };

  const followServerLog = async (s: ServerView, source: { id: string; label: string }) => {
    const first = await c.api.servers.logs({ id: s.id, source: source.id, lines: 200 });
    const key = panelKey("server-log");
    const stop = c.live.followLog(
      s.id,
      source.id,
      (more) => c.update(key, (p) => ({ ...p, lines: [...(p.lines ?? []), ...more].slice(-3000) })),
      (error) =>
        c.update(key, (p) => ({
          ...p,
          lines: [...(p.lines ?? []), ansi.dim(error ? `— stopped: ${error}` : "— the log ended")],
        })),
    );
    c.push({
      key,
      title: `${s.name} · ${source.label} (followed)`,
      lines: [...first.notes.map((n) => ansi.yellow(n)), ...first.lines],
      anchor: "bottom",
      onClose: stop,
      hint: "New lines come as they are written · ↑↓ scroll · Esc stops following",
    });
  };

  const logs = async () => {
    const st = c.get();
    if (st.server && (st.chatServer || !st.job)) {
      const s = st.server;
      const sources = await c.api.servers.logSources({ id: s.id });
      if (!sources.length) throw new Error(`No logs found on ${s.name}.`);
      c.push({
        key: panelKey("log-sources"),
        title: `Logs · ${s.name}`,
        items: sources.map((x) => ({ label: x.label, detail: x.kind })),
        onPick: async (i) => {
          const src = sources[i];
          if (src) await followServerLog(s, src);
        },
        hint: "A number follows that log.",
      });
      return;
    }
    if (st.job) {
      const j = st.job;
      const list = await c.api.sessions.list({ jobId: j.id });
      if (!list.length) throw new Error(`${j.title} has no sessions yet.`);
      const shown = [...list].reverse();
      c.push({
        key: panelKey("sessions"),
        title: `Sessions · ${j.title}`,
        items: shown.map((x) => ({
          label: `${x.endedAt === null ? ansi.magenta("◐ ") : ""}${x.taskTitle ?? x.purpose}`,
          detail: `${x.legName} · ${x.model} · ${ago(x.startedAt, c.now())}${x.endReason ? ` · ${x.endReason}` : ""}`,
        })),
        onPick: async (i) => {
          const x = shown[i];
          if (x)
            c.push(await sessionLogPanel(x.id, `${x.taskTitle ?? x.purpose} · ${x.legName}`, j.id));
        },
        topics: [`job:${j.id}`],
        hint: "A number shows that session's log.",
      });
      return;
    }
    const t = await c.api.logs.tail({ lines: 300 });
    c.push({
      key: panelKey("daemon-log"),
      title: `Oraknid's log · ${t.file}`,
      lines: t.lines,
      anchor: "bottom",
    });
  };

  // ── questions, the inbox ─────────────────────────────────────────

  /** One question after another, each a numbered list; my answers sent at the end. */
  const askQuestions = (
    title: string,
    questions: Question[],
    submit: (answers: QuestionAnswer[]) => Promise<void>,
  ) => {
    const step = async (i: number, answers: QuestionAnswer[], first: boolean) => {
      if (i >= questions.length) {
        await submit(answers);
        c.pop();
        c.flash("Answered.", "ok");
        return;
      }
      const q = questions[i] as Question;
      const go = (a: QuestionAnswer) => step(i + 1, [...answers, a], false);
      const choice = q.shape !== "text";
      const panel: Panel = {
        key: panelKey("question"),
        title: `${title} · ${i + 1} of ${questions.length}`,
        lines: renderMarkdown(q.prompt),
        ...(choice ? { items: questionItems(q) } : {}),
        selected: Math.max(
          0,
          q.options.findIndex((o) => o.id === q.recommended),
        ),
        ...(choice ? { onPick: (n: number) => go(answerOf(q, { options: [n + 1] })) } : {}),
        onText: (text) => {
          const ns = q.shape === "multi" ? pickedNumbers(text, q.options.length) : null;
          if (ns) return go(answerOf(q, { options: ns }));
          if (choice && !q.allowOther) throw new Error("Pick one of the options by its number.");
          return go(answerOf(q, { text }));
        },
        hint:
          q.shape === "text"
            ? "Type your answer, then Enter."
            : q.shape === "multi"
              ? "Numbers like 1,3 for several; one number for one; or your own words."
              : `A number picks${q.allowOther ? "; or type your own answer" : ""}.`,
      };
      if (first) c.push(panel);
      else c.replace(panel);
    };
    return step(0, [], true);
  };

  const answer = async () => {
    const st = c.get();
    const replied = new Set(st.messages.map((m) => m.replyTo).filter(Boolean));
    const open = [...st.messages]
      .reverse()
      .find((m) => m.author === "eye" && m.questions?.length && !replied.has(m.id));
    if (!open?.questions) throw new Error("The Eye has no open questions here.");
    await askQuestions("The Eye asks", open.questions, async (answers) => {
      if (st.chatServer && st.server)
        await c.api.servers.answer({ id: st.server.id, messageId: open.id, answers });
      else await c.api.projects.answer({ id: needProject().id, messageId: open.id, answers });
    });
  };

  const inboxItem = (it: InboxItem) => {
    const head = [
      `${it.kind === "approval" ? ansi.yellow("Approval") : ansi.cyan("Question")} · ${it.projectName ?? ""}${it.jobTitle ? ` · ${it.jobTitle}` : ""}`,
      "",
      ...renderMarkdown(it.detail),
    ];
    if (it.questions?.length) {
      void askQuestions(it.title, it.questions, async (answers) => {
        await c.api.inbox.answer({ id: it.id, answers });
      }).catch((e) => c.flash(message(e), "error"));
      return;
    }
    const done = async (a: string) => {
      await c.api.inbox.answer({ id: it.id, answer: a });
      c.pop();
      c.flash(`Answered: ${a}`, "ok");
    };
    c.push({
      key: panelKey("inbox-item"),
      title: it.title,
      lines: head,
      items: it.options.map((o) => ({
        label: `${o}${o === it.defaultOption ? ansi.dim(" (default)") : ""}`,
      })),
      onPick: (i) => {
        const o = it.options[i];
        if (o) return done(o);
      },
      onText: done,
      hint: it.options.length
        ? "A number picks an option; or type your answer."
        : "Type your answer, then Enter.",
    });
  };

  const inbox = async () => {
    c.clearNotice();
    const load = () => c.api.inbox.list({ state: "open" });
    const toItems = (list: InboxItem[]) =>
      list.map((it) => ({
        label: `${it.kind === "approval" ? ansi.yellow("!") : ansi.cyan("?")} ${it.title}`,
        detail: `${it.projectName ?? ""}${it.jobTitle ? ` · ${it.jobTitle}` : ""} · ${ago(it.createdAt, c.now())}`,
      }));
    let list = await load();
    if (!list.length) {
      c.flash("Nothing waiting for you.", "ok");
      return;
    }
    c.push({
      key: panelKey("inbox"),
      title: "Inbox · waiting for you",
      items: toItems(list),
      onPick: (i) => {
        const it = list[i];
        if (it) inboxItem(it);
      },
      topics: ["inbox"],
      refresh: async () => {
        list = await load();
        return { items: toItems(list) };
      },
      hint: "A number opens it.",
    });
  };

  // ── servers ──────────────────────────────────────────────────────

  const serverPanel = (s: ServerView): Panel => ({
    key: panelKey("server"),
    title: `Server · ${s.name}`,
    lines: serverLines(s, c.now()),
    anchor: "top",
    topics: ["overview"],
    refresh: async () => {
      const fresh = (await c.api.servers.list()).find((x) => x.id === s.id);
      if (fresh) c.set({ server: fresh });
      return fresh ? { lines: serverLines(fresh, c.now()) } : {};
    },
    hint: "/chat · /docker · /db · /proxy · /logs · /state · /ssh · /backups",
  });

  const chooseServer = (s: ServerView) => {
    c.set({ server: s, chatServer: false });
    c.push(serverPanel(s));
  };

  const servers = async () => {
    const list = await c.api.servers.list();
    c.set({ servers: list });
    if (!list.length) {
      c.flash("No servers yet: add one in the web UI (Servers).", "error");
      return;
    }
    c.push({
      key: panelKey("servers"),
      title: "Servers",
      items: list.map((s) => ({
        label: `${s.name}${s.production ? ansi.red("  production") : ""}${s.error ? ansi.red("  !") : ""}`,
        detail: `${s.user}@${s.host} · ${s.setup === "ready" ? "set up" : "not set up"} · seen ${ago(s.lastSeenAt, c.now())}`,
      })),
      onPick: (i) => {
        const s = list[i];
        if (s) chooseServer(s);
      },
      hint: "A number opens its overview.",
    });
  };

  const server = async (arg: string) => {
    if (!arg) {
      const s = c.get().server;
      return s ? c.push(serverPanel(s)) : servers();
    }
    const list = c.get().servers.length ? c.get().servers : await c.api.servers.list();
    c.set({ servers: list });
    const s = pickBy(list, arg, (x) => x.name);
    if (!s) throw new Error(`No server “${arg}”: /servers lists them.`);
    chooseServer(s);
  };

  const chat = () => {
    const s = needServer();
    const on = !c.get().chatServer;
    c.set({ chatServer: on });
    c.closeAll();
    c.flash(
      on
        ? `Talking to ${s.name}'s Eye: ask about it, or for work on it.`
        : "Back to the project's Eye.",
      "ok",
    );
  };

  const docker = async () => {
    const s = needServer();
    const { data: d, at } = await c.api.servers.docker({ id: s.id });
    const lines: string[] = [
      ansi.dim(
        `${d.engine ?? "no container engine"} ${d.version ?? ""} · read ${ago(at, c.now())}`,
      ),
    ];
    if (d.error) lines.push(ansi.red(d.error));
    for (const x of d.containers)
      lines.push(
        `${x.state === "running" ? ansi.green("●") : ansi.dim("○")} ${ansi.bold(x.name)}  ${ansi.dim(x.image)}`,
        `    ${x.status}${x.health ? ` · ${x.health}` : ""}${x.ports ? ` · ${x.ports}` : ""}${x.memBytes !== null ? ` · ${bytes(x.memBytes)}` : ""}`,
      );
    if (d.images.length) {
      lines.push("", ansi.bold(`Images (${d.images.length})`));
      for (const im of d.images)
        lines.push(
          `  ${im.repository}:${im.tag}  ${ansi.dim(`${bytes(im.sizeBytes)}${im.inUse ? "" : " · unused"}`)}`,
        );
    }
    c.push({ key: panelKey("docker"), title: `Docker · ${s.name}`, lines, anchor: "top" });
  };

  const db = async () => {
    const s = needServer();
    const { data } = await c.api.servers.databases({ id: s.id });
    const lines = data.databases.map(
      (x) =>
        `${ansi.bold(x.kind)} ${x.name}  ${ansi.dim(`${x.source} · ${x.version ?? "?"} · ${x.state}${x.port ? ` · port ${x.port}` : ""}${x.sizeBytes !== null ? ` · ${bytes(x.sizeBytes)}` : ""}`)}${x.note ? `\n    ${ansi.dim(x.note)}` : ""}`,
    );
    if (!lines.length) lines.push("No databases found.");
    lines.push(...data.notes.map((n) => ansi.yellow(n)));
    c.push({
      key: panelKey("db"),
      title: `Databases · ${s.name}`,
      lines: lines.flatMap((l) => l.split("\n")),
      anchor: "top",
    });
  };

  const proxy = async () => {
    const s = needServer();
    const { data } = await c.api.servers.proxy({ id: s.id });
    const lines: string[] = [];
    for (const p of data.proxies) {
      lines.push(
        `${ansi.bold(p.kind)} ${p.name}  ${ansi.dim(`${p.source} · ${p.version ?? "?"} · ${p.state}`)}${p.check?.ok === false ? ansi.red("  config check failed") : ""}`,
      );
      for (const site of p.sites)
        lines.push(
          `  ${site.names.join(", ") || "(default)"}  ${ansi.dim(`${site.listen.join(" ")}${site.upstreams.length ? ` → ${site.upstreams.join(", ")}` : ""}${site.root ? ` · ${site.root}` : ""}${site.redirect ? ` → ${site.redirect}` : ""}`)}`,
        );
      for (const cert of p.certificates)
        lines.push(
          `  ${ansi.dim("cert")} ${cert.path}  ${cert.expiresAt ? `ends ${new Date(cert.expiresAt).toISOString().slice(0, 10)}` : (cert.error ?? "")}`,
        );
      if (p.note) lines.push(`  ${ansi.dim(p.note)}`);
    }
    if (!lines.length) lines.push("No proxy found.");
    lines.push(...data.notes.map((n) => ansi.yellow(n)));
    c.push({ key: panelKey("proxy"), title: `Proxy · ${s.name}`, lines, anchor: "top" });
  };

  const state = async () => {
    const s = needServer();
    const doc = await c.api.servers.state({ id: s.id });
    c.push({
      key: panelKey("state"),
      title: `State · ${s.name}${doc ? ` · version ${doc.version}` : ""}`,
      lines: doc
        ? renderMarkdown(doc.body)
        : ["No state document yet: set the server up in the web UI."],
      anchor: "top",
    });
  };

  const backups = async () => {
    const s = c.get().server;
    const plans = await c.api.backups.plans(s ? { serverId: s.id } : undefined);
    if (!plans.length) {
      c.flash(s ? `No backup plans for ${s.name}.` : "No backup plans yet.", "error");
      return;
    }
    c.push({
      key: panelKey("backups"),
      title: s ? `Backups · ${s.name}` : "Backups",
      items: plans.map((p) => {
        const r = p.lastRun;
        return {
          label: `${p.enabled ? "" : ansi.dim("(off) ")}${p.name}${p.running ? ansi.magenta("  running") : ""}`,
          detail: r
            ? `last ${r.state} ${ago(r.startedAt, c.now())}${r.size !== null ? ` · ${bytes(r.size)}` : ""}${r.verifyOk === false ? " · verify failed" : ""}${p.nextRunAt ? ` · next ${new Date(p.nextRunAt).toISOString().slice(0, 16).replace("T", " ")}` : ""}`
            : "never run",
        };
      }),
      onPick: async (i) => {
        const p = plans[i];
        if (!p) return;
        const runs = await c.api.backups.runs({ planId: p.id, limit: 30 });
        c.push({
          key: panelKey("backup-runs"),
          title: `Runs · ${p.name}`,
          lines: runs.length
            ? runs.map(
                (r) =>
                  `${r.state === "ok" ? ansi.green("✓") : r.state === "failed" ? ansi.red("✗") : "·"} ${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")}  ${ansi.dim(`${r.trigger} · ${bytes(r.size)}${r.error ? ` · ${r.error}` : ""}`)}`,
              )
            : ["No runs yet."],
          items: [{ label: "Run it now" }],
          onPick: async () => {
            await c.api.backups.run({ id: p.id });
            c.flash(`${p.name}: running now.`, "ok");
          },
        });
      },
      topics: ["overview"],
      hint: "A number shows its runs.",
    });
  };

  /** Sites across my servers (ADR-060): up or down, the certificate's end, DNS. */
  const sites = async () => {
    const list = await c.api.sites.list();
    if (!list.length) {
      c.flash(
        "No sites yet: Find sites on the Servers page reads them from your proxies.",
        "error",
      );
      return;
    }
    c.push({
      key: panelKey("sites"),
      title: "Sites",
      items: list.map((x) => ({
        label: `${!x.checkEnabled ? ansi.dim("○") : x.downSince ? ansi.red("●") : x.up ? ansi.green("●") : ansi.yellow("●")} ${x.host}`,
        detail: [
          x.serverName ? `on ${x.serverName}` : "added by hand",
          x.downSince
            ? `down since ${ago(x.downSince, c.now())}`
            : x.lastLatencyMs !== null
              ? `${x.lastLatencyMs} ms`
              : "",
          x.uptime24h !== null ? `${(x.uptime24h * 100).toFixed(1)}% today` : "",
          x.cert.expiresAt !== null
            ? `cert ends ${new Date(x.cert.expiresAt).toISOString().slice(0, 10)}`
            : "",
          x.dns?.pointsHere === false ? "DNS points elsewhere" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      onPick: async (i) => {
        const x = list[i];
        if (!x) return;
        const r = await c.api.sites.refresh({ id: x.id });
        c.flash(
          `${r.host}: ${r.up ? "up" : "down"}${r.lastStatus ? ` (${r.lastStatus})` : ""}${r.lastError ? ` · ${r.lastError}` : ""}`,
          r.up ? "ok" : "error",
        );
      },
      topics: ["overview"],
      hint: "A number checks it now.",
    });
  };

  const ssh = () => {
    const s = needServer();
    c.shell(s);
  };

  // ── agents, models, usage, health ────────────────────────────────

  const agents = async () => {
    const [legs, usage] = await Promise.all([
      c.api.legs.list(),
      c.api.legs.planUsage().catch(() => []),
    ]);
    if (!legs.length) {
      c.flash("No Legs yet: add one in the web UI (Legs).", "error");
      return;
    }
    const byLeg = new Map(usage.map((u) => [u.legId, u]));
    c.push({
      key: panelKey("agents"),
      title: "Agents (Legs)",
      items: legs.map((l) => {
        const u = byLeg.get(l.id);
        const fullest = u?.windows.find((w) => w.utilization !== null);
        return {
          label: `${l.health === "healthy" ? ansi.green("●") : l.health === "disabled" ? ansi.dim("○") : ansi.yellow("●")} ${l.name}${l.paused ? ansi.yellow("  paused") : ""}`,
          detail: `${l.kind} · ${l.health}${l.remote ? " · remote" : " · local"} · ${l.models.filter((m) => !m.hidden).length} models${fullest ? ` · ${fullest.label} ${Math.round((fullest.utilization ?? 0) * 100)}%` : ""}${l.setupHint ? ` · ${l.setupHint}` : ""}`,
        };
      }),
      onPick: (i) => {
        const l = legs[i];
        if (!l) return;
        const u = byLeg.get(l.id);
        c.push({
          key: panelKey("agent"),
          title: `Leg · ${l.name}`,
          anchor: "top",
          lines: [
            `${ansi.bold(l.name)}  ${ansi.dim(`${l.kind} · ${l.health}`)}`,
            ...(l.healthDetail ? [ansi.dim(l.healthDetail)] : []),
            ...(l.setupHint ? [ansi.yellow(l.setupHint)] : []),
            "",
            ansi.bold("Plan windows"),
            ...(u?.windows.length
              ? u.windows.map(
                  (w) =>
                    `  ${w.label}: ${w.utilization === null ? "?" : `${Math.round(w.utilization * 100)}%`}${w.resetsAt ? ansi.dim(` · resets ${new Date(w.resetsAt).toISOString().slice(0, 16).replace("T", " ")}`) : ""}${w.estimated ? ansi.dim(" (estimated)") : ""}`,
                )
              : [ansi.dim("  Not known.")]),
            "",
            ansi.bold("Models"),
            ...l.models.map(
              (m) =>
                `  ${m.hidden ? ansi.dim(`${m.displayName} (hidden)`) : m.displayName}  ${ansi.dim(m.model)}`,
            ),
          ],
        });
      },
      hint: "A number shows its models and plan windows.",
    });
  };

  const models = async () => {
    const lines: string[] = [];
    // Local models (ADR-054) come with their own procedures; an Oraknid without them says so.
    const local = c.api as unknown as { models?: { list?: () => Promise<unknown> } };
    try {
      const list = await local.models?.list?.();
      lines.push(ansi.bold("Local models"));
      const xs = Array.isArray(list)
        ? (list as { name?: string; id?: string; state?: string; sizeBytes?: number }[])
        : [];
      if (!xs.length) lines.push(ansi.dim("  None yet."));
      for (const m of xs)
        lines.push(
          `  ${m.name ?? m.id ?? "?"}${m.state ? ansi.dim(` · ${m.state}`) : ""}${m.sizeBytes ? ansi.dim(` · ${bytes(m.sizeBytes)}`) : ""}`,
        );
    } catch (e) {
      if (!isMissing(e)) throw e;
      lines.push(ansi.dim("Local models (ADR-054) are not in this Oraknid yet."));
    }
    const legs = await c.api.legs.list();
    for (const l of legs) {
      lines.push("", `${ansi.bold(l.name)} ${ansi.dim(`${l.kind} · ${l.health}`)}`);
      for (const m of l.models.filter((x) => !x.hidden))
        lines.push(
          `  ${m.displayName}  ${ansi.dim(`${m.model}${m.effortLevels.length ? ` · ${m.effortLevels.join("/")}` : ""}`)}`,
        );
    }
    c.push({ key: panelKey("models"), title: "Models", lines, anchor: "top" });
  };

  const usage = async () => {
    const [sum, plans] = await Promise.all([
      c.api.stats.summary({}),
      c.api.legs.planUsage().catch(() => []),
    ]);
    const lines = JSON.stringify(sum, null, 1)
      .split("\n")
      .filter((l) => !/^[[\]{}],?$/.test(l.trim()))
      .map((l) =>
        l
          .replace(
            /^\s*"([^"]+)":\s*/,
            (_m, k: string) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: `,
          )
          .replace(/,$/, ""),
      );
    lines.unshift(ansi.bold("Oraknid's use"));
    lines.push("", ansi.bold("Plan windows"));
    for (const p of plans)
      for (const w of p.windows)
        lines.push(
          `  ${p.name} · ${w.label}: ${w.utilization === null ? "?" : `${Math.round(w.utilization * 100)}%`}`,
        );
    if (!plans.length) lines.push(ansi.dim("  None known."));
    c.push({ key: panelKey("usage"), title: "Usage", lines, anchor: "top" });
  };

  const health = async () => {
    const h = await c.api.machine.health();
    const r = h.reading;
    const lines = [
      `${h.state === "ok" ? ansi.green("ok") : h.state === "busy" ? ansi.yellow("busy") : ansi.red("danger")} · ${h.running} task${h.running === 1 ? "" : "s"} running of ${h.limit}${h.limitIsAuto ? " (the machine's own limit)" : ""}`,
    ];
    if (r)
      lines.push(
        `memory ${Math.round(r.memoryUsed * 100)}% · cpu ${Math.round(r.cpu * 100)}%${r.swapUsed !== null ? ` · swap ${Math.round(r.swapUsed * 100)}%` : ""}${r.diskFreeBytes !== null ? ` · ${bytes(r.diskFreeBytes)} free` : ""}`,
      );
    for (const i of h.incidents)
      lines.push(
        `${i.level === "danger" ? ansi.red("!") : ansi.yellow("!")} ${i.message}${i.did ? ansi.dim(` — ${i.did}`) : ""}`,
      );
    if (h.pausedForRoom.length) {
      lines.push("", ansi.bold("Paused to make room"));
      for (const p of h.pausedForRoom) lines.push(`  ${p.title}`);
    }
    c.push({
      key: panelKey("health"),
      title: "Health · this computer",
      lines,
      anchor: "top",
      topics: ["overview"],
      refresh: async () => ({}),
    });
  };

  // ── mail, repos, storage, chats, skills ──────────────────────────

  const mail = async () => {
    const accounts = await c.api.mail.accounts();
    if (!accounts.length) {
      c.flash("No mail accounts yet: add one in the web UI (Mail).", "error");
      return;
    }
    c.push({
      key: panelKey("mail"),
      title: "Mail",
      items: accounts.map((a) => ({
        label: `${a.name} ${ansi.dim(`<${a.email}>`)}${a.unread ? ansi.cyan(`  ${a.unread} unread`) : ""}`,
        detail: `${a.state}${a.error ? ` · ${a.error}` : ""} · synced ${ago(a.lastSyncAt, c.now())}`,
      })),
      onPick: async (i) => {
        const a = accounts[i];
        if (!a) return;
        const page = await c.api.mail.threads({ accountId: a.id, limit: 100 });
        const threads = Array.isArray(page)
          ? page
          : ((page as { threads?: unknown[] }).threads ?? []);
        c.push({
          key: panelKey("threads"),
          title: `Mail · ${a.email}`,
          anchor: "top",
          lines: (
            threads as {
              subject?: string;
              from?: string;
              unread?: boolean;
              lastAt?: number;
              snippet?: string;
            }[]
          ).map(
            (t) =>
              `${t.unread ? ansi.cyan("●") : " "} ${ansi.bold(t.subject || "(no subject)")}  ${ansi.dim(`${t.from ?? ""}${t.lastAt ? ` · ${ago(t.lastAt, c.now())}` : ""}`)}`,
          ),
        });
      },
      topics: ["mail"],
      hint: "A number shows its threads.",
    });
  };

  const repos = async () => {
    const list = await c.api.github.repos();
    const xs = list as {
      fullName?: string;
      name?: string;
      description?: string | null;
      private?: boolean;
      pushedAt?: string | number | null;
    }[];
    c.push({
      key: panelKey("repos"),
      title: "Repositories on GitHub",
      anchor: "top",
      lines: xs.length
        ? xs.map(
            (r) =>
              `${ansi.bold(r.fullName ?? r.name ?? "?")}${r.private ? ansi.dim(" · private") : ""}${r.description ? `  ${ansi.dim(r.description)}` : ""}`,
          )
        : ["No repositories: add a GitHub account in the web UI (Settings → GitHub)."],
    });
  };

  const storage = async () => {
    const u = await c.api.storage.usage();
    const lines = [
      ansi.bold(`Oraknid's data · ${u.dataDir}`),
      `  database ${bytes(u.database)} · backups ${bytes(u.backups.bytes)} · audit ${bytes(u.audit)} · its log ${bytes(u.daemonLog)}`,
      `  jobs' raw logs ${bytes(u.jobs.reduce((n, j) => n + j.bytes, 0))} in ${u.jobs.length} jobs`,
    ];
    for (const j of [...u.jobs].sort((a, b) => b.bytes - a.bytes).slice(0, 10))
      lines.push(`    ${bytes(j.bytes).padStart(8)}  ${j.title} ${ansi.dim(j.state)}`);
    try {
      const cloud = (await c.api.cloud.status()) as unknown as Record<string, unknown>;
      lines.push("", ansi.bold("Cloud storage"));
      const providers =
        (cloud.providers as
          | {
              name?: string;
              label?: string;
              usedBytes?: number;
              totalBytes?: number;
              error?: string | null;
            }[]
          | undefined) ?? [];
      if (!providers.length)
        lines.push(ansi.dim("  No providers: add one in the web UI (Storage)."));
      for (const p of providers)
        lines.push(
          `  ${p.label ?? p.name ?? "?"}${p.usedBytes !== undefined ? ` · ${bytes(p.usedBytes)}${p.totalBytes ? ` of ${bytes(p.totalBytes)}` : ""}` : ""}${p.error ? ansi.red(` · ${p.error}`) : ""}`,
        );
    } catch {}
    c.push({ key: panelKey("storage"), title: "Storage", lines, anchor: "top" });
  };

  const chats = async () => {
    const list = await c.api.chats.list();
    if (!list.length) {
      c.flash("No chats yet: start one in the web UI (Chats).", "error");
      return;
    }
    c.push({
      key: panelKey("chats"),
      title: "Chats",
      items: list.map((x) => ({
        label: x.title,
        detail: `${x.modelLabel} · ${ago(x.updatedAt, c.now())}`,
      })),
      onPick: async (i) => {
        const x = list[i];
        if (!x) return;
        const { messages } = await c.api.chats.get({ id: x.id });
        c.push({
          key: panelKey("chat"),
          title: `Chat · ${x.title}`,
          anchor: "bottom",
          lines: messages.flatMap((m) =>
            m.author === "owner"
              ? [`${ansi.cyan("›")} ${ansi.bold(m.text)}`, ""]
              : [...renderMarkdown(m.error ? ansi.red(m.error) : m.text).map((l) => `  ${l}`), ""],
          ),
        });
      },
      hint: "A number shows the conversation.",
    });
  };

  const skills = async () => {
    const list = (await c.api.skills.list()) as {
      name?: string;
      title?: string;
      description?: string;
      builtIn?: boolean;
    }[];
    c.push({
      key: panelKey("skills"),
      title: "Skills",
      anchor: "top",
      lines: list.length
        ? list.map(
            (s) =>
              `${ansi.bold(s.name ?? s.title ?? "?")}${s.description ? `  ${ansi.dim(s.description)}` : ""}`,
          )
        : ["No skills."],
    });
  };

  // ── settings, update, doctor, help ───────────────────────────────

  interface Setting {
    name: string;
    help: string;
    read: () => Promise<string>;
    write: (v: string) => Promise<unknown>;
  }
  const num = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error("A whole number, please.");
    return n;
  };
  const onOff = (v: string) => {
    if (/^(on|yes|true|1)$/i.test(v)) return true;
    if (/^(off|no|false|0)$/i.test(v)) return false;
    throw new Error("on or off, please.");
  };
  const SETTINGS: Setting[] = [
    {
      name: "max-running-jobs",
      help: "Jobs running at once (1 to 20)",
      read: async () => String(await c.api.settings.maxRunningJobs()),
      write: (v) => c.api.settings.setMaxRunningJobs({ max: num(v) }),
    },
    {
      name: "max-tasks-per-job",
      help: "Tasks of one job running at once (1 to 16, or auto: as many as the machine admits)",
      read: async () => String((await c.api.settings.maxTasksPerJob()) ?? "auto"),
      write: (v) => c.api.settings.setMaxTasksPerJob({ max: /^auto$/i.test(v) ? null : num(v) }),
    },
    {
      name: "interview-rounds",
      help: "Rounds of questions before a plan, at most (1 to 12)",
      read: async () => String(await c.api.settings.interviewRounds()),
      write: (v) => c.api.settings.setInterviewRounds({ rounds: num(v) }),
    },
    {
      name: "terminal",
      help: "The terminal and /ssh (on or off; off until turned on)",
      read: async () => ((await c.api.settings.terminal()) ? "on" : "off"),
      write: (v) => c.api.settings.setTerminal({ enabled: onOff(v) }),
    },
  ];

  const setSetting = async (s: Setting, v: string) => {
    await s.write(v.trim());
    c.flash(`${s.name} is now ${await s.read()}.`, "ok");
  };

  const settings = async (arg: string) => {
    const [name, ...rest] = arg.split(/\s+/).filter(Boolean);
    if (name) {
      const s = SETTINGS.find((x) => x.name === name || x.name.startsWith(name));
      if (!s) throw new Error(`No setting “${name}”: /settings lists them.`);
      if (rest.length) return setSetting(s, rest.join(" "));
    }
    const values = await Promise.all(SETTINGS.map((s) => s.read().catch(() => "?")));
    c.push({
      key: panelKey("settings"),
      title: "Settings",
      items: SETTINGS.map((s, i) => ({
        label: `${s.name}: ${ansi.bold(values[i] ?? "?")}`,
        detail: s.help,
      })),
      onPick: (i) => {
        const s = SETTINGS[i];
        if (!s) return;
        c.push({
          key: panelKey("setting"),
          title: `Settings · ${s.name}`,
          lines: [s.help, "", `Now: ${values[i]}`],
          onText: async (v) => {
            await setSetting(s, v);
            c.pop();
            c.pop();
            await settings("");
          },
          hint: "Type the new value, then Enter.",
        });
      },
      hint: "A number changes it; or /settings <name> <value>. The rest is in the web UI.",
    });
  };

  const update = async () => {
    const v = await c.api.updates.check();
    const i = v.install;
    const lines = [
      i.mode === "script"
        ? `Oraknid ${v.version} · ${i.channel} channel · installed from ${i.ref}${i.gui ? "" : " · terminal only"}`
        : `Oraknid ${v.version} · running from a clone at ${i.appDir}`,
    ];
    if (v.error) lines.push(ansi.red(v.error));
    for (const r of v.newer)
      lines.push("", ansi.bold(`${r.tag} — ${r.name}`), ...renderMarkdown(r.notes).slice(0, 12));
    if (v.devAhead?.count) {
      lines.push("", ansi.bold(`New work on dev (${v.devAhead.count} commits)`));
      for (const x of v.devAhead.commits.slice(0, 10))
        lines.push(`  ${x.sha.slice(0, 7)} ${x.message}`);
    }
    lines.push(
      "",
      v.available
        ? ansi.green(`Update available${v.target ? `: ${v.target}` : ""}.`)
        : "Up to date.",
    );
    if (v.whyNot && v.available) lines.push(ansi.dim(v.whyNot));
    const can = v.available && v.canUpdate;
    c.push({
      key: panelKey("update"),
      title: "Update",
      lines,
      anchor: "top",
      ...(can
        ? {
            items: [
              {
                label: `Update now${v.runningJobs ? ` (${v.runningJobs} running job(s) pause and go on after)` : ""}`,
              },
            ],
            onPick: async () => {
              const run = await c.api.updates.run({ confirm: true });
              c.pop();
              c.flash(
                `Updating to ${run.target}: Oraknid restarts, and this app reconnects.`,
                "ok",
              );
            },
          }
        : {}),
    });
  };

  const doctor = async () => {
    const checks = await c.api.system.doctor();
    c.push({
      key: panelKey("doctor"),
      title: "Doctor",
      anchor: "top",
      lines: checks.flatMap((x) => [
        `${x.ok ? ansi.green("✓") : ansi.red("✗")} ${x.name}: ${x.detail}`,
        ...(x.fix ? [ansi.dim(`    → ${x.fix}`)] : []),
      ]),
    });
  };

  const help = () =>
    c.push({
      key: panelKey("help"),
      title: "Help",
      anchor: "top",
      lines: [
        "Type to talk to The Eye of the current project (or the server's, after /chat).",
        "A line ending in \\ goes on to a new one. Esc stops The Eye's thinking, or goes back.",
        "While it thinks, Tab chooses what your message does: redo with it, or add it as context.",
        "In a list, a number or ↑↓ and Enter picks; PgUp/PgDn scroll; Ctrl+C clears, then quits.",
        "",
        ...helpLines(),
      ],
    });

  const stop = async () => {
    const st = c.get();
    const id = st.chatServer ? st.server?.projectId : st.project?.id;
    if (!id) throw new Error("Nothing to stop.");
    const { stopped } = await c.api.projects.stopThinking({ id });
    c.flash(stopped ? "Stopped." : "The Eye isn't thinking.", "ok");
  };

  const table: Record<string, (args: string) => unknown> = {
    projects,
    project,
    jobs,
    job,
    logs,
    pause: () => control("pause"),
    resume: () => control("resume"),
    cancel,
    redirect,
    inbox,
    answer,
    stop,
    servers,
    server,
    chat,
    docker,
    db,
    proxy,
    state,
    ssh,
    backups,
    sites,
    agents,
    models,
    usage,
    health,
    mail,
    repos,
    ci: ciCommand(c, needProject),
    storage,
    chats,
    skills,
    settings,
    update,
    doctor,
    help,
    quit: () => c.quit(),
  };

  return {
    /** Runs a command by name; an unknown one says so. */
    async run(name: string, args: string) {
      const spec = findCommand(name);
      const f = spec ? table[spec.name] : undefined;
      if (!f) throw new Error(`No command /${name}: /help lists them.`);
      await f(args);
    },
    loadProjects,
    names: COMMANDS.map((x) => x.name),
  };
}
