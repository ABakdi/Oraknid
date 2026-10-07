import type {
  EyeMessage,
  EyeThought,
  JobView,
  ServerView,
  SessionLogEntry,
  SessionView,
} from "@oraknid/contracts";
import { correctsThinking } from "@oraknid/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Api, type AppState, makeActions, message } from "./actions.ts";
import { completions, numberPick, parseInput } from "./commands.ts";
import type { LiveFeed, LiveStatus } from "./live.ts";
import { ansi } from "./markdown.ts";
import type { Panel } from "./panels.ts";
import { messageLines, seconds, thoughtLine, thoughtTail, transcript } from "./transcript.ts";

// The terminal app (ADR-055): The Eye's conversation of the current project
// above, a prompt at the bottom, slash commands with completion, panels of
// numbered lists picked by number; live over the same socket as the web.

/** What is kept between two openings, and across a shell on a server. */
export interface Snapshot {
  projectId: string | null;
  serverId: string | null;
  chatServer: boolean;
}

export interface AppProps {
  api: Api;
  live: LiveFeed;
  initial?: Partial<Snapshot>;
  /** /ssh: the app makes way for a shell on the server, and opens again after it. */
  onShell?: (server: ServerView, snapshot: Snapshot) => void;
  /** Leaving (/quit, Ctrl+C twice): what to remember. */
  onQuit?: (snapshot: Snapshot) => void;
  /** The bell, for a question, an approval or danger. */
  bell?: () => void;
  now?: () => number;
  /** The terminal's size; read from it otherwise. */
  size?: { rows: number; columns: number };
}

type Tone = "ok" | "error";

const TOPICS_BASE = ["overview", "inbox"];

export function App(props: AppProps) {
  const { api, live } = props;
  const now = props.now ?? Date.now;
  const { exit } = useApp();
  const stdout = useStdout().stdout as NodeJS.WriteStream | undefined;
  const [size, setSize] = useState(() => ({
    rows: props.size?.rows ?? stdout?.rows ?? 30,
    columns: props.size?.columns ?? stdout?.columns ?? 100,
  }));
  useEffect(() => {
    if (props.size || !stdout?.on) return;
    const onResize = () => setSize({ rows: stdout.rows ?? 30, columns: stdout.columns ?? 100 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, props.size]);

  // ── what is current ──────────────────────────────────────────────
  const [state, setState] = useState<AppState>({
    project: null,
    server: null,
    job: null,
    chatServer: false,
    projects: [],
    jobs: [],
    servers: [],
    messages: [],
  });
  const S = useRef(state);
  S.current = state;
  const set = useCallback((patch: Partial<AppState>) => {
    S.current = { ...S.current, ...patch };
    setState((s) => ({ ...s, ...patch }));
  }, []);

  const [panels, setPanels] = useState<Panel[]>([]);
  const P = useRef(panels);
  P.current = panels;
  const setPanelsNow = useCallback((f: (ps: Panel[]) => Panel[]) => {
    P.current = f(P.current);
    setPanels(P.current);
  }, []);
  const top = panels.at(-1);

  const [text, setText] = useState("");
  const [menu, setMenu] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [back, setBack] = useState(-1);
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useState<{ text: string; tone: Tone } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<"redo" | "context" | null>(null);
  const [status, setStatus] = useState<LiveStatus>(live.status());
  const [quitting, setQuitting] = useState(false);

  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((t: string, tone: Tone = "ok") => {
    setFlash({ text: t, tone });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), tone === "error" ? 8000 : 4000);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const snapshot = useCallback(
    (): Snapshot => ({
      projectId: S.current.project?.id ?? null,
      serverId: S.current.server?.id ?? null,
      chatServer: S.current.chatServer,
    }),
    [],
  );

  const quit = useCallback(() => {
    for (const p of P.current) p.onClose?.();
    props.onQuit?.(snapshot());
    exit();
  }, [exit, props.onQuit, snapshot]);

  const actions = useMemo(
    () =>
      makeActions({
        api,
        live,
        get: () => S.current,
        set,
        push: (p) => setPanelsNow((ps) => [...ps, p]),
        replace: (p) =>
          setPanelsNow((ps) => {
            ps.at(-1)?.onClose?.();
            return [...ps.slice(0, -1), p];
          }),
        pop: () =>
          setPanelsNow((ps) => {
            ps.at(-1)?.onClose?.();
            return ps.slice(0, -1);
          }),
        closeAll: () =>
          setPanelsNow((ps) => {
            for (const p of ps) p.onClose?.();
            return [];
          }),
        update: (key, f) => setPanelsNow((ps) => ps.map((p) => (p.key === key ? f(p) : p))),
        flash: say,
        clearNotice: () => setNotice(null),
        shell: (server) => {
          for (const p of P.current) p.onClose?.();
          props.onShell?.(server, snapshot());
          if (props.onShell) exit();
          else say("A shell isn't available here.", "error");
        },
        quit,
        now,
      }),
    [api, live, set, setPanelsNow, say, quit, now, exit, props.onShell, snapshot],
  );

  const act = useCallback(
    (f: () => unknown) => {
      Promise.resolve()
        .then(f)
        .catch((e) => say(message(e), "error"));
    },
    [say],
  );

  // ── the start: the project, the server, what waits ───────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, at the start
  useEffect(() => {
    act(async () => {
      const list = await actions.loadProjects();
      const want = props.initial?.projectId;
      const project = list.find((p) => p.id === want) ?? (list.length === 1 ? list[0] : undefined);
      if (project) set({ project });
      else if (list.length) say("Pick a project to talk to its Eye: /projects", "ok");
      else say("No projects yet: ask for one in the web UI, or see /help.", "ok");
      if (props.initial?.serverId) {
        const servers = await api.servers.list();
        const server = servers.find((s) => s.id === props.initial?.serverId) ?? null;
        set({ servers, server, chatServer: !!server && !!props.initial?.chatServer });
      }
      const open = await api.inbox.list({ state: "open" });
      if (open.length) setNotice(`${open.length} waiting for you: /inbox`);
    });
  }, []);

  useEffect(() => live.onStatus(() => setStatus(live.status())), [live]);

  // ── the conversation ─────────────────────────────────────────────
  const talkProjectId = state.chatServer
    ? (state.server?.projectId ?? null)
    : (state.project?.id ?? null);
  const convoKey = state.chatServer ? `s:${state.server?.id}` : `p:${state.project?.id}`;
  const [convo, setConvo] = useState<{
    key: string;
    messages: EyeMessage[];
    thoughts: EyeThought[];
    jobs: JobView[];
    sessions: SessionView[];
  }>({ key: "", messages: [], thoughts: [], jobs: [], sessions: [] });
  const [tick, setTick] = useState(0);
  const [epoch, setEpoch] = useState(live.epoch());
  useEffect(() => live.onStatus(() => setEpoch(live.epoch())), [live]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on the conversation, a tick, or a snapshot
  useEffect(() => {
    const st = S.current;
    if (!st.project && !(st.chatServer && st.server)) return;
    let gone = false;
    (async () => {
      const messages =
        st.chatServer && st.server
          ? await api.servers.conversation({ id: st.server.id })
          : st.project
            ? await api.projects.conversation({ id: st.project.id })
            : [];
      const pid = talkProjectId;
      const [thoughts, jobs] = pid
        ? await Promise.all([api.projects.thinking({ id: pid }), api.jobs.list({ projectId: pid })])
        : [[], []];
      const going = jobs.filter(
        (j) => !["draft", "completed", "cancelled", "failed"].includes(j.state),
      );
      const sessions = (
        await Promise.all(going.map((j) => api.sessions.list({ jobId: j.id })))
      ).flat();
      if (gone) return;
      setConvo({ key: convoKey, messages, thoughts, jobs, sessions });
      set({ messages });
    })().catch((e) => !gone && say(message(e), "error"));
    return () => {
      gone = true;
    };
  }, [convoKey, talkProjectId, tick, epoch]);

  const shown =
    convo.key === convoKey ? convo : { messages: [], thoughts: [], jobs: [], sessions: [] };
  const busy = shown.thoughts.filter((th) => th.outcome === "thinking" && th.interruptible);
  const runningThoughts = shown.thoughts.filter((th) => th.outcome === "thinking");
  const jobIds = shown.jobs.map((j) => j.id);

  // What The Eye writes while it thinks, and what the agents do now.
  const [thoughtLogs, setThoughtLogs] = useState<Record<string, SessionLogEntry[]>>({});
  const nextLog = useRef<Record<string, number>>({});
  const [logTick, setLogTick] = useState(0);
  const [doing, setDoing] = useState<Record<string, string>>({});
  const runningKey = runningThoughts.map((t) => t.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the running thoughts and their ticks
  useEffect(() => {
    let gone = false;
    for (const th of runningThoughts) {
      (async () => {
        for (let i = 0; i < 20; i++) {
          const after = nextLog.current[th.id] ?? 0;
          const page = await api.sessions.log({ id: th.id, after });
          if (gone) return;
          nextLog.current[th.id] = page.next;
          if (!page.entries.length) break;
          setThoughtLogs((x) => ({ ...x, [th.id]: joinLog(x[th.id] ?? [], page.entries) }));
          if (page.next === after) break;
        }
      })().catch(() => {});
    }
    return () => {
      gone = true;
    };
  }, [runningKey, logTick]);

  // Live: the conversation's topics, and a notice for what asks for me.
  const topicsKey = [...TOPICS_BASE, ...jobIds.map((id) => `job:${id}`)].join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the topics identify the subscription
  useEffect(() => {
    const topics = topicsKey.split(",");
    const off = live.subscribe(topics);
    let t: ReturnType<typeof setTimeout> | undefined;
    let lt: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (!topics.includes(e.topic)) return;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === "inbox.opened") {
        setNotice(
          `${p.kind === "approval" ? "Approval" : "Question"}: ${String(p.title ?? "")} — /inbox`,
        );
        props.bell?.();
      }
      if (e.type === "machine.incident" && p.level === "danger") {
        setNotice(`Danger: ${String(p.message ?? "")}${p.did ? ` — ${String(p.did)}` : ""}`);
        props.bell?.();
      }
      if (typeof p.sessionId === "string") {
        const sid = p.sessionId;
        if (e.type === "session.tool.called" || e.type === "session.text") {
          const line =
            e.type === "session.tool.called"
              ? `${String(p.tool ?? "tool")} ${describe(p.input)}`
              : (String(p.text ?? "")
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .at(-1) ?? "");
          if (line) setDoing((d) => ({ ...d, [sid]: line.slice(0, 200) }));
        }
        if (runningKey.includes(sid)) {
          clearTimeout(lt);
          lt = setTimeout(() => setLogTick((n) => n + 1), 200);
        }
      }
      if (
        e.type.startsWith("eye.") ||
        e.type.startsWith("job.") ||
        e.type === "session.started" ||
        e.type === "session.ended"
      ) {
        clearTimeout(t);
        t = setTimeout(() => setTick((n) => n + 1), 150);
      }
    });
    return () => {
      off();
      offEvents();
      clearTimeout(t);
      clearTimeout(lt);
    };
  }, [topicsKey, runningKey]);

  // The panel on top reads itself again when its topics move.
  const topKey = top?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel on top identifies it
  useEffect(() => {
    const p = top;
    if (!p?.topics?.length || !p.refresh) return;
    const off = live.subscribe(p.topics);
    let t: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (!p.topics?.includes(e.topic)) return;
      clearTimeout(t);
      t = setTimeout(() => {
        p.refresh?.()
          .then((patch) =>
            setPanelsNow((ps) => ps.map((x) => (x.key === p.key ? { ...x, ...patch } : x))),
          )
          .catch(() => {});
      }, 300);
    });
    return () => {
      off();
      offEvents();
      clearTimeout(t);
    };
  }, [topKey]);

  // A clock for elapsed times, while something runs.
  const [clock, setClock] = useState(now());
  const ticking = runningThoughts.length > 0 || shown.sessions.some((s) => s.endedAt === null);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, now]);

  // ── typing ───────────────────────────────────────────────────────
  const menuItems = useMemo(
    () => completions(text, { job: !!state.job, server: !!state.server }),
    [text, state.job, state.server],
  );
  const menuOpen = menuItems.length > 0;
  const mode = picked ?? (correctsThinking(text) ? "redo" : "context");

  const pick = (p: Panel, index: number) => {
    if (!p.items?.length || !p.onPick) return false;
    if (index < 0 || index >= p.items.length) {
      say(`No item ${index + 1} here: 1 to ${p.items.length}.`, "error");
      return true;
    }
    setPanelsNow((ps) => ps.map((x) => (x.key === p.key ? { ...x, selected: index } : x)));
    act(() => p.onPick?.(index));
    return true;
  };

  const send = (value: string) => {
    act(async () => {
      const st = S.current;
      if (st.chatServer && st.server) await api.servers.talk({ id: st.server.id, text: value });
      else {
        if (!st.project) throw new Error("No project chosen: pick one with /projects.");
        await api.projects.talk({
          id: st.project.id,
          text: value,
          mode: busy.length ? mode : "auto",
        });
      }
      setPicked(null);
      setScroll(0);
      setPanelsNow((ps) => {
        for (const p of ps) p.onClose?.();
        return [];
      });
      setTick((n) => n + 1);
    });
  };

  const submit = () => {
    if (menuOpen) {
      const spec = menuItems[Math.min(menu, menuItems.length - 1)];
      if (spec && text !== `/${spec.name}` && spec.args && !spec.args.startsWith("[")) {
        setText(`/${spec.name} `);
        setMenu(0);
        return;
      }
      if (spec) {
        setText("");
        setMenu(0);
        setHistory((h) => [...h, `/${spec.name}`]);
        act(() => actions.run(spec.name, ""));
        return;
      }
    }
    if (text.endsWith("\\")) {
      setText(`${text.slice(0, -1)}\n`);
      return;
    }
    const value = text;
    const parsed = parseInput(value);
    setText("");
    setBack(-1);
    setMenu(0);
    if (parsed.kind !== "empty") setHistory((h) => [...h, value.trim()].slice(-100));
    const p = P.current.at(-1);
    switch (parsed.kind) {
      case "empty":
        if (p?.items?.length) pick(p, p.selected ?? 0);
        return;
      case "number":
        if (p?.items?.length && p.onPick) {
          pick(p, parsed.n - 1);
          return;
        }
        if (p?.onText) return act(() => p.onText?.(value.trim()));
        return send(value.trim());
      case "command":
        return act(() => actions.run(parsed.name, parsed.args));
      case "text":
        if (p?.onText) return act(() => p.onText?.(parsed.text));
        return send(parsed.text);
    }
  };

  const mainRows = Math.max(
    4,
    size.rows -
      (notice ? 1 : 0) -
      (busy.length ? 1 : 0) -
      (menuOpen ? Math.min(8, menuItems.length) : 0) -
      (flash ? 1 : 0) -
      (text.split("\n").length + 2) -
      1,
  );

  const scrollPanel = (by: number) => {
    const p = P.current.at(-1);
    if (!p) return setScroll((s) => Math.max(0, s + by));
    if (p.items?.length) {
      const sel = Math.max(0, Math.min(p.items.length - 1, (p.selected ?? 0) - by));
      return setPanelsNow((ps) => ps.map((x) => (x.key === p.key ? { ...x, selected: sel } : x)));
    }
    const max = Math.max(0, (p.lines?.length ?? 0) - (mainRows - 2));
    const dir = p.anchor === "top" ? -1 : 1;
    const s = Math.max(0, Math.min(max, (p.scroll ?? 0) + dir * by));
    setPanelsNow((ps) => ps.map((x) => (x.key === p.key ? { ...x, scroll: s } : x)));
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (text) {
        setText("");
        return;
      }
      if (quitting) return quit();
      setQuitting(true);
      say("Ctrl+C again to leave (Oraknid keeps running).", "ok");
      setTimeout(() => setQuitting(false), 3000);
      return;
    }
    if (key.escape) {
      if (menuOpen) return setText("");
      if (P.current.length) {
        setPanelsNow((ps) => {
          ps.at(-1)?.onClose?.();
          return ps.slice(0, -1);
        });
        return;
      }
      if (busy.length) return act(() => actions.run("stop", ""));
      if (text) return setText("");
      if (scroll) return setScroll(0);
      return;
    }
    if (key.return) return submit();
    if (key.tab) {
      if (menuOpen) {
        const spec = menuItems[Math.min(menu, menuItems.length - 1)];
        if (spec) setText(`/${spec.name}${spec.args ? " " : ""}`);
        setMenu(0);
        return;
      }
      if (busy.length && text.trim()) setPicked(mode === "redo" ? "context" : "redo");
      return;
    }
    if (key.upArrow || key.downArrow) {
      const by = key.upArrow ? 1 : -1;
      if (menuOpen) {
        setMenu((m) => (m - by + menuItems.length) % menuItems.length);
        return;
      }
      if (P.current.length && !text) return scrollPanel(by);
      // The prompts I sent, again.
      if (!history.length) return;
      const i = key.upArrow ? Math.min(history.length - 1, back + 1) : Math.max(-1, back - 1);
      setBack(i);
      setText(i < 0 ? "" : (history[history.length - 1 - i] ?? ""));
      return;
    }
    if (key.pageUp || key.pageDown) {
      const page = Math.max(1, mainRows - 3) * (key.pageUp ? 1 : -1);
      if (P.current.length)
        return scrollPanel(P.current.at(-1)?.items?.length ? Math.sign(page) * 5 : page);
      return setScroll((s) => Math.max(0, s + page));
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      setMenu(0);
      return;
    }
    if (key.ctrl && input === "u") return setText("");
    if (key.ctrl && input === "w") return setText((t) => t.replace(/\S+\s*$/, ""));
    if (!input || key.ctrl || key.meta) return;
    const typed = text + input.replace(/\r\n?/g, "\n");
    // A number in a list picks as soon as no longer one could be meant.
    const p = P.current.at(-1);
    if (p?.items?.length && p.onPick) {
      const n = numberPick(typed, p.items.length);
      if (n && "pick" in n) {
        setText("");
        pick(p, n.pick - 1);
        return;
      }
    }
    setText(typed);
    setMenu(0);
  });

  // ── drawing ──────────────────────────────────────────────────────
  const where = [
    state.chatServer && state.server
      ? `${ansi.cyan("◉")} ${state.server.name}'s Eye`
      : state.project
        ? `${ansi.cyan("◉")} ${state.project.name}`
        : ansi.dim("no project"),
    state.server && !state.chatServer ? `server ${state.server.name}` : null,
    state.job ? `job ${state.job.title}` : null,
    status === "live"
      ? ansi.green("● live")
      : status === "reconnecting"
        ? ansi.yellow("● reconnecting")
        : ansi.red("● offline"),
  ]
    .filter(Boolean)
    .join(ansi.dim(" · "));

  return (
    <Box flexDirection="column" height={size.rows} width={size.columns}>
      {notice ? (
        <Text wrap="truncate-end">
          {ansi.yellow("▲")} {notice}
        </Text>
      ) : null}
      <Box flexDirection="column" height={mainRows} overflowY="hidden" justifyContent="flex-end">
        {top ? (
          <PanelView panel={top} rows={mainRows} depth={panels.length} />
        ) : (
          <TranscriptLines
            lines={conversationLines({
              messages: shown.messages,
              thoughts: shown.thoughts,
              jobs: shown.jobs,
              sessions: shown.sessions,
              logs: thoughtLogs,
              doing,
              now: clock,
              server: state.chatServer ? (state.server?.name ?? null) : null,
              hasProject: !!state.project,
            })}
            rows={mainRows}
            scroll={scroll}
          />
        )}
      </Box>
      {busy.length ? (
        <Text wrap="truncate-end">
          {ansi.magenta("◐")} The Eye is{" "}
          {(busy[0]?.purpose ?? "thinking").replace(/^./, (c) => c.toLowerCase())}…{" "}
          {text.trim()
            ? `${ansi.dim("Tab:")} ${mode === "redo" ? ansi.bold("[stop and redo with this]") : "stop and redo with this"} ${ansi.dim("/")} ${mode === "context" ? ansi.bold("[add as context]") : "add as context"}`
            : ansi.dim("Esc stops it · write to correct it or add to it")}
        </Text>
      ) : null}
      {menuOpen ? <Menu items={menuItems} selected={Math.min(menu, menuItems.length - 1)} /> : null}
      {flash ? (
        <Text wrap="truncate-end">
          {flash.tone === "error" ? ansi.red(flash.text) : ansi.green(flash.text)}
        </Text>
      ) : null}
      <Box borderStyle="round" borderColor={top?.onText ? "yellow" : "gray"} paddingX={1}>
        <Text>
          {ansi.cyan("›")} {text}
          <Text inverse> </Text>
          {!text
            ? ansi.dim(
                top?.onText
                  ? " your answer…"
                  : top?.items?.length
                    ? " a number picks · Esc back"
                    : " ask The Eye, or / for commands",
              )
            : ""}
        </Text>
      </Box>
      <Text wrap="truncate-end">{where}</Text>
    </Box>
  );
}

/** Streamed text and reasoning may be split across reads: joined to the line before. */
export function joinLog(xs: SessionLogEntry[], more: SessionLogEntry[]): SessionLogEntry[] {
  const out = xs.slice();
  for (const e of more) {
    const last = out.at(-1);
    if ((e.kind === "text" || e.kind === "thinking") && last?.kind === e.kind)
      out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push(e);
  }
  return out;
}

/** What a tool call does, in a few words. */
function describe(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query;
  return typeof pick === "string" ? (pick.split("\n")[0]?.slice(0, 160) ?? "") : "";
}

/** The whole conversation as lines: what the transcript area shows the end of. */
export function conversationLines(o: {
  messages: EyeMessage[];
  thoughts: EyeThought[];
  jobs: JobView[];
  sessions: SessionView[];
  logs: Record<string, SessionLogEntry[]>;
  doing: Record<string, string>;
  now: number;
  server: string | null;
  hasProject: boolean;
}): string[] {
  if (!o.hasProject && !o.server)
    return [ansi.dim("No project chosen. /projects lists them; /help says what else there is.")];
  const items = transcript(o.messages, o.thoughts);
  if (!items.length)
    return [
      ansi.dim(
        o.server
          ? `Nothing said yet. Ask what runs on ${o.server}, or for work on it.`
          : "Nothing said yet. Ask for work here: The Eye starts a job for it, or passes it to the one running.",
      ),
    ];
  const byId = new Map(o.jobs.map((j) => [j.id, j]));
  const replied = new Set(o.messages.map((m) => m.replyTo).filter(Boolean));
  const out: string[] = [];
  let lastJob: string | null | undefined;
  for (const item of items) {
    const jobId =
      item.kind === "message"
        ? item.message.jobId
        : item.kind === "thought"
          ? item.thought.jobId
          : item.thoughts[0]?.jobId;
    if (item.kind === "message" && lastJob !== undefined && jobId !== lastJob) {
      const title = jobId ? (byId.get(jobId)?.title ?? "another job") : "no job";
      out.push(ansi.dim(`── ${title} ──`));
    }
    if (item.kind === "message" || lastJob === undefined) lastJob = jobId ?? null;
    if (item.kind === "message") {
      out.push(...messageLines(item.message, byId, replied.has(item.message.id)), "");
    } else if (item.kind === "thought") {
      out.push(thoughtLine(item.thought, o.now));
      if (item.thought.outcome === "thinking")
        out.push(...thoughtTail(o.logs[item.thought.id] ?? []));
    } else {
      const last = item.thoughts.at(-1);
      out.push(
        ansi.dim(
          `· Thought ${item.thoughts.length} times${last ? ` · last: ${last.summary ?? last.purpose}` : ""}`,
        ),
      );
    }
  }
  const lastMessage = o.messages.at(-1);
  if (lastMessage?.author === "owner" && !o.thoughts.some((th) => th.outcome === "thinking"))
    out.push(ansi.dim("The Eye is reading your message…"));
  const working = o.sessions.filter((s) => s.endedAt === null && s.purpose === "task");
  if (working.length) {
    out.push(ansi.dim("╌".repeat(24)));
    for (const s of working)
      out.push(
        `${ansi.green("●")} ${ansi.bold(s.taskTitle ?? "A task")}  ${o.doing[s.id] ?? ansi.dim("starting…")}  ${ansi.dim(`${s.legName} · ${s.model} · ${seconds(o.now - s.startedAt)}`)}`,
      );
  }
  while (out.length && !out.at(-1)?.trim()) out.pop();
  return out;
}

function TranscriptLines({
  lines,
  rows,
  scroll,
}: {
  lines: string[];
  rows: number;
  scroll: number;
}) {
  const end = Math.max(0, lines.length - scroll);
  const shown = lines.slice(Math.max(0, end - rows), end);
  return (
    <>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
        <Text key={i} wrap="wrap">
          {l || " "}
        </Text>
      ))}
      {scroll ? (
        <Text>{ansi.dim(`↓ ${scroll} more lines below · PgDn · Esc to the end`)}</Text>
      ) : null}
    </>
  );
}

function PanelView({ panel: p, rows, depth }: { panel: Panel; rows: number; depth: number }) {
  const lines = p.lines ?? [];
  const items = p.items ?? [];
  const hint =
    p.hint ??
    (items.length ? "A number or ↑↓ Enter picks · Esc back" : "↑↓ PgUp PgDn scroll · Esc back");
  const room = Math.max(1, rows - 2);
  let head = lines;
  let list: { n: number; label: string; detail?: string }[] = [];
  if (items.length) {
    // The lines above the list keep at most half the room; the list shows around the chosen one.
    head = lines.slice(0, Math.max(0, Math.floor(room / 2)));
    const fit = Math.max(
      1,
      Math.floor((room - head.length) / (items.some((x) => x.detail) ? 2 : 1)),
    );
    const sel = p.selected ?? 0;
    const from = Math.max(0, Math.min(items.length - fit, sel - Math.floor(fit / 2)));
    list = items.slice(from, from + fit).map((x, i) => ({
      n: from + i + 1,
      label: x.label,
      ...(x.detail ? { detail: x.detail } : {}),
    }));
  } else {
    const s = p.scroll ?? 0;
    head =
      p.anchor === "top"
        ? lines.slice(s, s + room)
        : lines.slice(Math.max(0, lines.length - room - s), lines.length - s);
  }
  const width = String(items.length).length;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {ansi.bold(p.title)}
        {depth > 1 ? ansi.dim(`  (${depth} deep · Esc back)`) : ""}
      </Text>
      {head.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
        <Text key={`h${i}`} wrap="wrap">
          {l || " "}
        </Text>
      ))}
      {list.map((x) => {
        const on = x.n - 1 === (p.selected ?? 0);
        return (
          <Box key={`i${x.n}`} flexDirection="column">
            <Text wrap="truncate-end">
              {on ? ansi.cyan("❯") : " "} {ansi.dim(`${String(x.n).padStart(width)}.`)}{" "}
              {on ? ansi.bold(x.label) : x.label}
            </Text>
            {x.detail ? (
              <Text wrap="truncate-end">{`   ${" ".repeat(width)}${ansi.dim(x.detail)}`}</Text>
            ) : null}
          </Box>
        );
      })}
      <Text wrap="truncate-end">{ansi.dim(hint)}</Text>
    </Box>
  );
}

/** The commands completing what I type: eight at most, around the chosen one. */
function Menu({
  items,
  selected,
}: {
  items: { name: string; args?: string; help: string }[];
  selected: number;
}) {
  const from = Math.max(0, Math.min(items.length - 8, selected - 4));
  const shown = items.slice(from, from + 8);
  const width = Math.max(...shown.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length));
  return (
    <Box flexDirection="column">
      {shown.map((c, i) => {
        const head = `/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(width);
        return (
          <Text key={c.name} wrap="truncate-end">
            {from + i === selected ? `${ansi.cyan("❯")} ${ansi.bold(head)}` : `  ${head}`}{" "}
            {ansi.dim(c.help)}
          </Text>
        );
      })}
    </Box>
  );
}
