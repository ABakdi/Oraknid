import type {
  Event,
  EyeMessage,
  EyeThought,
  InboxItem,
  JobView,
  ServerView,
} from "@oraknid/contracts";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "./actions.ts";
import { App } from "./app.tsx";
import { COMMANDS, completions, numberPick, parseInput } from "./commands.ts";
import type { LiveFeed } from "./live.ts";
import { plain, renderMarkdown } from "./markdown.ts";
import { planTree } from "./panels.ts";
import { transcript } from "./transcript.ts";

// The terminal app (ADR-055): commands read and completed, numbers picked,
// The Eye's conversation drawn, and every action an API call, against a
// stand-in API and live socket.

describe("slash commands", () => {
  it("reads a command, a number, or words for The Eye", () => {
    expect(parseInput("  ")).toEqual({ kind: "empty" });
    expect(parseInput("/job 3")).toMatchObject({ kind: "command", name: "job", args: "3" });
    expect(parseInput("/redirect use Postgres instead")).toMatchObject({
      name: "redirect",
      args: "use Postgres instead",
    });
    expect(parseInput("/exit")).toMatchObject({ kind: "command", name: "quit" });
    expect(parseInput("/nope")).toMatchObject({ kind: "command", name: "nope", spec: undefined });
    expect(parseInput("12")).toEqual({ kind: "number", n: 12 });
    expect(parseInput("add tests for the piano")).toEqual({
      kind: "text",
      text: "add tests for the piano",
    });
    // A path is words, not a command.
    expect(parseInput("/etc/nginx is wrong")).toMatchObject({ kind: "text" });
  });

  it("completes as I type: / lists them all, a word filters, starts before contains", () => {
    const ctx = { job: false, server: false };
    expect(completions("/", ctx)).toHaveLength(COMMANDS.length);
    expect(completions("/se", ctx).map((c) => c.name)).toEqual([
      "servers",
      "server",
      "settings",
      "pause",
    ]);
    // What fits where I am comes first: on a server, /chat before the job's /cancel.
    expect(
      completions("/c", { job: false, server: true })
        .slice(0, 3)
        .map((c) => c.name),
    ).toEqual(["chat", "ci", "chats"]);
    expect(
      completions("/c", { job: true, server: false })
        .slice(0, 3)
        .map((c) => c.name),
    ).toEqual(["cancel", "ci", "chats"]);
    expect(completions("/logs", ctx).map((c) => c.name)).toEqual(["logs"]);
    expect(completions("/oc", ctx).map((c) => c.name)).toEqual(["doctor", "docker"]);
    expect(completions("/job 1", ctx)).toEqual([]);
    expect(completions("hello", ctx)).toEqual([]);
  });

  it("picks by number at once when no longer number fits, else waits for Enter", () => {
    expect(numberPick("3", 5)).toEqual({ pick: 3 });
    expect(numberPick("1", 12)).toEqual({ wait: true });
    expect(numberPick("12", 12)).toEqual({ pick: 12 });
    expect(numberPick("2", 12)).toEqual({ pick: 2 });
    expect(numberPick("7", 5)).toBeNull();
    expect(numberPick("0", 5)).toBeNull();
    expect(numberPick("x", 5)).toBeNull();
  });

  it("has a line of help for every command", () => {
    for (const c of COMMANDS) expect(c.help.length).toBeGreaterThan(10);
    const names = COMMANDS.map((c) => c.name);
    for (const n of [
      "projects",
      "jobs",
      "inbox",
      "servers",
      "chat",
      "docker",
      "db",
      "proxy",
      "logs",
      "state",
      "ssh",
      "backups",
      "agents",
      "models",
      "usage",
      "health",
      "mail",
      "repos",
      "storage",
      "chats",
      "skills",
      "settings",
      "update",
      "doctor",
      "help",
      "quit",
    ])
      expect(names).toContain(n);
  });
});

describe("markdown for the terminal", () => {
  it("renders headings, emphasis, code, lists and links, every line kept", () => {
    const out = renderMarkdown(
      "# Plan\n\nI'll **add** the `Piano` component:\n\n- keys\n- [x] sound\n1. first\n\n```ts\nconst a = 1;\n```\n\nSee [the docs](https://x.dev).",
    ).map(plain);
    expect(out).toEqual([
      "Plan",
      "",
      "I'll add the Piano component:",
      "",
      "• keys",
      "☑ sound",
      "1. first",
      "",
      "  ts",
      "  const a = 1;",
      "",
      "See the docs (https://x.dev).",
    ]);
  });
});

// ── a stand-in daemon ───────────────────────────────────────────────

const T0 = 1_760_000_000_000;

function project(id: string, name: string) {
  return {
    id,
    name,
    workspacePath: `/home/me/${name}`,
    isGitRepo: true,
    releaseBranch: "main",
    workBranch: "dev",
    createdAt: T0,
    archivedAt: null,
    serverId: null,
    jobCount: 1,
    shadow: false,
  };
}

function eyeMessage(over: Partial<EyeMessage>): EyeMessage {
  return {
    id: "m1",
    jobId: "J1",
    projectId: "P1",
    author: "eye",
    text: "",
    action: null,
    questions: null,
    itemId: null,
    answers: null,
    replyTo: null,
    createdAt: T0,
    ...over,
  } as EyeMessage;
}

function thought(over: Partial<EyeThought>): EyeThought {
  return {
    id: "S1",
    jobId: "J1",
    call: "plan",
    purpose: "Planning the work",
    model: "Claude · Opus",
    startedAt: T0 + 2000,
    endedAt: null,
    outcome: "thinking",
    summary: null,
    again: false,
    interruptible: true,
    ...over,
  };
}

function task(id: string, title: string, dependsOn: string[], state = "pending") {
  return {
    id,
    jobId: "J1",
    title,
    instructions: `Do ${title}.`,
    dependsOn,
    kind: "implement",
    scope: [],
    verify: ["pnpm test"],
    requiredCapabilities: [],
    difficulty: "low",
    state,
    assignedLegId: null,
    assignedModelId: null,
    effort: null,
    attemptCount: 0,
    budget: null,
    routing: null,
    pinnedModelId: null,
    ownerHeld: false,
    waitingForLegId: null,
    avoidLegIds: [],
    waitingReason: null,
  };
}

const job = {
  id: "J1",
  projectId: "P1",
  title: "Build the piano",
  goal: "A piano",
  state: "running",
  tasks: [
    task("T1", "Scaffold the app", [], "done"),
    task("T2", "Keys component", ["T1"], "running"),
    task("T3", "Sound engine", ["T1"]),
    task("T4", "Tests", ["T2", "T3"]),
  ],
  description: null,
  tokens: 1200,
  pauseReason: null,
  blockedReason: null,
  branch: "oraknid/piano",
  createdAt: T0,
} as unknown as JobView;

const server = (id: string, name: string) =>
  ({
    id,
    name,
    host: `${name}.example`,
    port: 22,
    user: "deploy",
    description: "",
    auth: "oraknid-key",
    setup: "ready",
    hostKey: null,
    hostKeyOffered: null,
    lastSeenAt: T0,
    error: null,
    busy: null,
    stateVersion: 1,
    latest: null,
    projectIds: [],
    projectId: null,
    production: name === "prod",
    productionIn: [],
    createdAt: T0,
  }) as ServerView;

const inboxItem: InboxItem = {
  id: "I1",
  kind: "approval",
  jobId: "J1",
  taskId: null,
  raisedBy: "eye",
  title: "Push to origin?",
  detail: "The job wants to **push** its branch.",
  options: ["approve", "deny"],
  defaultOption: null,
  state: "open",
  answer: null,
  answeredAt: null,
  answeredByDeviceId: null,
  createdAt: T0,
  questions: null,
  answers: null,
  projectName: "piano",
  jobTitle: "Build the piano",
} as InboxItem;

function fakeDaemon(o: { thinking?: boolean } = {}) {
  const calls: { path: string; input: unknown }[] = [];
  const messages: EyeMessage[] = [
    eyeMessage({ id: "m0", author: "owner", text: "Build the piano from the spec", createdAt: T0 }),
    eyeMessage({
      id: "m1",
      text: "On it: **planning** the work now.",
      createdAt: T0 + 1000,
      action: { intent: "task", did: ["Started a job"], silkIds: [], taskIds: [], jobId: null },
    }),
  ];
  const thoughts = [
    thought({
      id: "S0",
      outcome: "done",
      endedAt: T0 + 1900,
      summary: "Read the spec",
      interruptible: true,
      startedAt: T0 + 1500,
    }),
    ...(o.thinking ? [thought({})] : []),
  ];
  const handlers: Record<string, (input: unknown) => unknown> = {
    "projects.list": () => [project("P1", "piano")],
    "projects.conversation": () => messages,
    "projects.thinking": () => thoughts,
    "projects.talk": () => ({ id: "m9", jobId: "J1" }),
    "projects.stopThinking": () => ({ stopped: 1 }),
    "jobs.list": () => [job],
    "jobs.get": () => job,
    "jobs.pause": () => undefined,
    "sessions.list": () => [
      {
        id: "S2",
        jobId: "J1",
        taskId: "T2",
        taskTitle: "Keys component",
        purpose: "task",
        legId: "L1",
        legName: "Claude",
        model: "sonnet",
        effort: null,
        startedAt: T0,
        endedAt: null,
        endReason: null,
        tokens: 0,
      },
    ],
    "sessions.log": () => ({
      entries: [{ at: T0, kind: "thinking", text: "The spec wants 88 keys." }],
      next: 1,
      live: true,
    }),
    "inbox.list": () => [inboxItem],
    "inbox.answer": () => undefined,
    "servers.list": () => [server("V1", "staging"), server("V2", "prod")],
  };
  const make = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, key: string) => make([...path, key]),
      apply: async (_t, _this, args: unknown[]) => {
        const p = path.join(".");
        calls.push({ path: p, input: args[0] });
        const h = handlers[p];
        if (!h)
          throw Object.assign(new Error(`No procedure ${p}`), { code: "NOT_FOUND", status: 404 });
        return h(args[0]);
      },
    });
  return { api: make([]) as Api, calls, handlers, messages };
}

function fakeLive() {
  const listeners = new Set<(e: Event) => void>();
  let seq = 100;
  const live: LiveFeed & { emit: (e: Partial<Event>) => void } = {
    status: () => "live",
    onStatus: () => () => {},
    subscribe: () => () => {},
    on: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    epoch: () => 0,
    followLog: () => () => {},
    close: () => {},
    emit: (e) => {
      for (const l of listeners)
        l({
          seq: seq++,
          at: T0,
          topic: "overview",
          jobId: null,
          payload: {},
          actor: "system",
          type: "x",
          ...e,
        } as Event);
    },
  };
  return live;
}

let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function open(o: { thinking?: boolean } = {}) {
  const d = fakeDaemon(o);
  const live = fakeLive();
  const bell = vi.fn();
  const r = render(
    <App
      api={d.api}
      live={live}
      bell={bell}
      now={() => T0 + 5000}
      size={{ rows: 40, columns: 110 }}
    />,
  );
  mounted = r;
  const frame = () => plain(r.lastFrame() ?? "");
  const until = async (pred: (f: string) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!pred(frame())) {
      if (Date.now() > deadline) throw new Error(`timed out; the screen:\n${frame()}`);
      await new Promise((res) => setTimeout(res, 20));
    }
  };
  const type = async (s: string) => {
    for (const ch of s) {
      r.stdin.write(ch);
      await new Promise((res) => setTimeout(res, 5));
    }
  };
  const press = async (key: string) => {
    r.stdin.write(key);
    await new Promise((res) => setTimeout(res, 60));
  };
  return { ...d, live, bell, r, frame, until, type, press };
}

const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

describe("the terminal app", () => {
  it("shows the project's conversation: my prompt marked ›, the reply rendered, thinking folded, work going on", async () => {
    const t = open();
    await t.until((f) => f.includes("Build the piano from the spec"));
    const f = t.frame();
    expect(f).toContain("› Build the piano from the spec");
    expect(f).toContain("On it: planning the work now.");
    expect(f).not.toContain("**planning**");
    expect(f).toContain("[New work] · Started a job");
    expect(f).toContain("✓ Read the spec in 0 s · Claude · Opus");
    expect(f).toContain("Keys component");
    expect(f).toContain("Claude · sonnet");
    expect(f).toContain("◉ piano");
    // Something waits in the inbox: said at the top.
    await t.until((x) => x.includes("1 waiting for you: /inbox"));
  });

  it("shows The Eye thinking live; Esc stops it; Tab chooses redo or context for what I write", async () => {
    const t = open({ thinking: true });
    await t.until((f) => f.includes("Planning the work… · 3 s"));
    await t.until((f) => f.includes("The spec wants 88 keys."));
    expect(t.frame()).toContain("Esc stops it");
    await t.press(ESC);
    await t.until(() => t.calls.some((c) => c.path === "projects.stopThinking"));
    expect(t.calls.find((c) => c.path === "projects.stopThinking")?.input).toEqual({ id: "P1" });

    await t.type("also a metronome");
    await t.until((f) => f.includes("[add as context]"));
    await t.press(TAB);
    await t.until((f) => f.includes("[stop and redo with this]"));
    await t.press(ENTER);
    await t.until(() => t.calls.some((c) => c.path === "projects.talk"));
    expect(t.calls.find((c) => c.path === "projects.talk")?.input).toEqual({
      id: "P1",
      text: "also a metronome",
      mode: "redo",
    });
  });

  it("sends what I type to the project's Eye, choosing for itself when it isn't thinking", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    await t.type("add a dark theme");
    await t.press(ENTER);
    await t.until(() => t.calls.some((c) => c.path === "projects.talk"));
    expect(t.calls.find((c) => c.path === "projects.talk")?.input).toEqual({
      id: "P1",
      text: "add a dark theme",
      mode: "auto",
    });
  });

  it("lists commands as I type /, filters them, and runs the chosen one", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/");
    await t.until((f) => f.includes("/projects") && f.includes("/jobs [all]"));
    await t.type("serv");
    await t.until((f) => !f.includes("/projects"));
    expect(t.frame()).toContain("/servers");
    expect(t.frame()).toContain("/server <n|name>");
    await t.press(ENTER);
    // The servers, numbered; a number picks at once.
    await t.until((f) => f.includes("Servers") && f.includes("2. prod"));
    expect(t.frame()).toContain("1. staging");
    await t.type("2");
    await t.until((f) => f.includes("Server · prod"));
    expect(t.frame()).toContain("deploy@prod.example:22");
    expect(t.frame()).toContain("/chat · /docker · /db");
    expect(t.frame()).toContain("server prod");
    // Esc goes back, a panel at a time, to the conversation.
    await t.press(ESC);
    await t.until((f) => f.includes("1. staging"));
    await t.press(ESC);
    await t.until((f) => f.includes("Build the piano from the spec"));
  });

  it("picks with ↑↓ and Enter too, and shows a job's plan as a tree", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/jobs");
    await t.press(ENTER);
    await t.until((f) => f.includes("Jobs · piano"));
    await t.press(ENTER);
    await t.until((f) => f.includes("Job · Build the piano"));
    const f = t.frame();
    expect(f).toContain("1/4 tasks");
    expect(f).toMatch(/1\. ✓ Scaffold the app/);
    expect(f).toMatch(/2\. └ ◐ Keys component/);
    expect(f).toMatch(/3\. {3}└ ○ Tests/);
    expect(f).toMatch(/4\. └ ○ Sound engine/);
    await t.press("\x1b[B");
    await t.press("\x1b[B");
    await t.press("\x1b[A");
    await t.press(ENTER);
    await t.until((x) => x.includes("Task · Keys component"));
    expect(t.frame()).toContain("$ pnpm test");
    await t.press(ESC);
    await t.press(ESC);
    await t.until((x) => x.includes("Jobs · piano"));
    await t.press(ESC);
    // The job stays current: /pause acts on it.
    await t.type("/pause");
    await t.press(ENTER);
    await t.until(() => t.calls.some((c) => c.path === "jobs.pause"));
    expect(t.calls.find((c) => c.path === "jobs.pause")?.input).toEqual({ id: "J1" });
  });

  it("/cancel with no job chosen cancels the conversation's job after y/N; n keeps it", async () => {
    const t = open();
    t.handlers["jobs.cancel"] = () => undefined;
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/cancel");
    await t.press(ENTER);
    await t.until((f) => f.includes("Cancel “Build the piano”?"));
    expect(t.frame()).toContain("The work so far stays in its folder");
    await t.type("n");
    await t.press(ENTER);
    await t.until((f) => f.includes("Build the piano: kept going."));
    expect(t.calls.some((c) => c.path === "jobs.cancel")).toBe(false);
    await t.type("/cancel");
    await t.press(ENTER);
    await t.until((f) => f.includes("Cancel “Build the piano”?"));
    await t.type("y");
    await t.press(ENTER);
    await t.until(() => t.calls.some((c) => c.path === "jobs.cancel"));
    expect(t.calls.find((c) => c.path === "jobs.cancel")?.input).toEqual({
      id: "J1",
      reason: "Cancelled from the terminal app.",
    });
    await t.until((f) => f.includes("Build the piano: cancelling."));
  });

  it("/cancel with several jobs going asks which first", async () => {
    const t = open();
    t.handlers["jobs.cancel"] = () => undefined;
    t.handlers["jobs.list"] = () => [
      job,
      { ...job, id: "J2", title: "Tune the strings", state: "paused" },
    ];
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/cancel");
    await t.press(ENTER);
    await t.until((f) => f.includes("Cancel which job?"));
    await t.type("1");
    await t.until((f) => f.includes("Cancel “Tune the strings”?"));
    await t.type("y");
    await t.press(ENTER);
    await t.until(() => t.calls.some((c) => c.path === "jobs.cancel"));
    expect(t.calls.find((c) => c.path === "jobs.cancel")?.input).toMatchObject({ id: "J2" });
  });

  it("answers the inbox by number", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/inbox");
    await t.press(ENTER);
    await t.until((f) => f.includes("Inbox · waiting for you"));
    await t.type("1");
    await t.until((f) => f.includes("The job wants to push its branch."));
    expect(t.frame()).toContain("2. deny");
    await t.type("2");
    await t.until(() => t.calls.some((c) => c.path === "inbox.answer"));
    expect(t.calls.find((c) => c.path === "inbox.answer")?.input).toEqual({
      id: "I1",
      answer: "deny",
    });
    await t.until((f) => f.includes("Answered: deny"));
  });

  it("tells me at the top, with the bell, when a question comes", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    t.live.emit({
      type: "inbox.opened",
      topic: "inbox",
      payload: { id: "I2", kind: "question", title: "Which database?" },
    });
    await t.until((f) => f.includes("Question: Which database? — /inbox"));
    expect(t.bell).toHaveBeenCalled();
  });

  it("says what a daemon without a procedure lacks instead of failing (/models)", async () => {
    const t = open();
    t.handlers["legs.list"] = () => [];
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/models");
    await t.press(ENTER);
    await t.until((f) => f.includes("Local models (ADR-054) are not in this Oraknid yet."));
  });

  it("says why a command can't run, and an unknown one", async () => {
    const t = open();
    await t.until((f) => f.includes("◉ piano"));
    await t.type("/docker");
    await t.press(ENTER);
    await t.until((f) => f.includes("No server chosen: pick one with /servers."));
    await t.type("/frobnicate x");
    await t.press(ENTER);
    await t.until((f) => f.includes("No command /frobnicate: /help lists them."));
  });
});

describe("the pieces", () => {
  it("folds three ended quick thoughts in a row into one", () => {
    const q = (id: string, at: number) =>
      thought({ id, startedAt: at, endedAt: at + 1, outcome: "done", interruptible: false });
    const items = transcript(
      [eyeMessage({ createdAt: T0 })],
      [q("a", T0 + 1), q("b", T0 + 2), q("c", T0 + 3)],
    );
    expect(items.map((i) => i.kind)).toEqual(["message", "thoughts"]);
  });

  it("puts each task under the first it depends on", () => {
    expect(planTree(job.tasks).map((x) => `${x.depth}:${x.task.id}`)).toEqual([
      "0:T1",
      "1:T2",
      "2:T4",
      "1:T3",
    ]);
  });
});
