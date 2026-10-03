import "@xterm/xterm/css/xterm.css";
import { Columns2, Grid2x2, Laptop, Maximize2, Plus, Server, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import { TerminalCard } from "@/components/terminal-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, auth } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { unlock } from "@/lib/lock";
import { remote } from "@/lib/remote";
import { cn } from "@/lib/utils";

interface Session {
  key: number;
  target: string;
  label: string;
}
type Layout = "one" | "columns" | "grid";

/**
 * The terminal workspace (ADR-028, Web-UI → Terminal): terminals in tabs,
 * side by side or in a grid, each a shell on this computer or a server.
 * Every shell stays open while I switch layouts or tabs.
 */
export function TerminalPage({ target }: { target?: string }) {
  const enabled = useLive(() => api.settings.terminal(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const servers = useLive(() => api.servers.list(), { topics: ["overview"] });
  // Away from home, a terminal needs full rights on this device (ADR-030).
  const lock = useLive(() => api.lock.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "device.rights",
  });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState(0);
  const [layout, setLayout] = useState<Layout>("one");
  const [picking, setPicking] = useState(false);
  const next = useRef(1);

  const label = (id: string) =>
    id === "local" ? t("This computer") : (servers.data?.find((s) => s.id === id)?.name ?? id);
  const open = (id: string) => {
    const key = next.current++;
    setSessions((s) => {
      setActive(s.length);
      return [...s, { key, target: id, label: label(id) }];
    });
    setPicking(false);
  };
  const close = (key: number) => {
    setSessions((s) => {
      const i = s.findIndex((x) => x.key === key);
      const rest = s.filter((x) => x.key !== key);
      setActive((a) => Math.max(0, Math.min(rest.length - 1, a > i ? a - 1 : a)));
      return rest;
    });
  };

  // The first terminal: the one in the address, or this computer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the page can open one
  useEffect(() => {
    if (enabled.data && next.current === 1 && (target === undefined || servers.data))
      open(target ?? "local");
  }, [enabled.data, servers.data]);

  // Shortcuts (Web-UI → Terminal): caught before the shell sees them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close only uses the state setters
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      const current = sessions[active];
      const act =
        e.key === "Enter"
          ? () => setPicking(true)
          : e.code === "KeyX"
            ? () => current && close(current.key)
            : e.key === "ArrowLeft"
              ? () => setActive((a) => Math.max(0, a - 1))
              : e.key === "ArrowRight"
                ? () => setActive((a) => Math.min(sessions.length - 1, a + 1))
                : digit
                  ? () => Number(digit) <= sessions.length && setActive(Number(digit) - 1)
                  : e.code === "KeyD"
                    ? () => setLayout((l) => (l === "columns" ? "one" : "columns"))
                    : e.code === "KeyG"
                      ? () => setLayout((l) => (l === "grid" ? "one" : "grid"))
                      : e.code === "KeyF"
                        ? () => setLayout("one")
                        : e.code === "KeyV"
                          ? () =>
                              void navigator.clipboard
                                ?.readText()
                                .then((text) =>
                                  window.dispatchEvent(
                                    new CustomEvent("oraknid-paste", { detail: text }),
                                  ),
                                )
                                .catch(() => {})
                          : null;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [sessions, active]);

  if (enabled.loading) return <Loading />;
  if (remote() && !lock.data?.full)
    return (
      <Note>
        {t(
          "The terminal opens away from home only on a device with full rights: give them to this device at home, in Settings → Devices & phone.",
        )}
      </Note>
    );
  // Off: turned on right here, with the same confirmation as in Settings → Security.
  if (!enabled.data)
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader
          title={t("Terminal")}
          sub={t("The terminal is off: it is a full shell as you.")}
        />
        <TerminalCard onChange={() => enabled.reload()} />
      </div>
    );

  const visible = (i: number) => layout !== "one" || i === active;
  return (
    <div className="-mb-24 flex h-[calc(100dvh-7.5rem)] min-h-0 flex-col gap-2 md:-mb-8 md:h-[calc(100dvh-4.5rem)]">
      <div className="flex shrink-0 items-center gap-1 border-b">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {sessions.map((s, i) => (
            <div
              key={s.key}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-0.5 border-b-2 border-transparent text-sm",
                i === active && "border-primary",
              )}
            >
              <button
                type="button"
                className={cn(
                  "flex max-w-48 items-center gap-1.5 py-2 pl-3 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11",
                  i === active && "font-medium text-foreground",
                )}
                onClick={() => setActive(i)}
                title={i < 9 ? `${s.label} (Ctrl+Shift+${i + 1})` : s.label}
              >
                {s.target === "local" ? (
                  <Laptop className="size-3.5" />
                ) : (
                  <Server className="size-3.5" />
                )}
                <span className="truncate">{s.label}</span>
              </button>
              <button
                type="button"
                className="flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-11"
                onClick={() => close(s.key)}
                title={t("Close (Ctrl+Shift+X)")}
                aria-label={t("Close {name}", { name: s.label })}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button
          data-help="terminal.new"
          variant="ghost"
          size="icon"
          title={t("New terminal (Ctrl+Shift+Enter)")}
          aria-label={t("New terminal")}
          onClick={() => setPicking(true)}
        >
          <Plus className="size-4" />
        </Button>
        <div data-help="terminal.layout" className="flex rounded-md border p-0.5">
          {(
            [
              ["one", Maximize2, t("One at a time (Ctrl+Shift+F)")],
              ["columns", Columns2, t("Side by side (Ctrl+Shift+D)")],
              ["grid", Grid2x2, t("Grid (Ctrl+Shift+G)")],
            ] as const
          ).map(([id, Icon, title]) => (
            <Button
              key={id}
              variant={layout === id ? "secondary" : "ghost"}
              size="icon"
              className="size-7"
              title={title}
              aria-label={title}
              onClick={() => setLayout(id)}
            >
              <Icon className="size-3.5" />
            </Button>
          ))}
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">{t("Open a terminal on:")}</div>
          <Targets servers={servers.data ?? []} onPick={open} />
        </div>
      ) : (
        <div
          className={cn(
            "grid min-h-0 flex-1 gap-2",
            layout === "one" && "grid-cols-1",
            layout === "columns" && "auto-cols-fr grid-flow-col",
            layout === "grid" && "auto-rows-fr grid-cols-1 sm:grid-cols-2",
          )}
        >
          {/* Every shell stays mounted; the layout only shows or hides it. */}
          {sessions.map((s, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: a click in a terminal makes it the active one; the keyboard has its shortcuts
            <div
              key={s.key}
              className={cn("min-h-0 min-w-0", !visible(i) && "hidden")}
              onMouseDown={() => setActive(i)}
            >
              <Term
                target={s.target}
                focused={i === active}
                visible={visible(i)}
                onExit={() => close(s.key)}
              />
            </div>
          ))}
        </div>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("New terminal")}</DialogTitle>
            <DialogDescription>
              {t("Where it opens. Every terminal opened is in the log.")}
            </DialogDescription>
          </DialogHeader>
          <Targets servers={servers.data ?? []} onPick={open} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A server's Terminal tab (ADR-043): one shell on it, opened with a click
 * (each opening is audited), closed when the page closes.
 */
export function ServerTerminal({ id, name }: { id: string; name: string }) {
  const enabled = useLive(() => api.settings.terminal(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const lock = useLive(() => api.lock.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "device.rights",
  });
  const [open, setOpen] = useState(0);
  if (enabled.error) return <ErrorNote error={enabled.error} />;
  if (enabled.loading) return <Loading />;
  if (remote() && !lock.data?.full)
    return (
      <Note>
        {t(
          "The terminal opens away from home only on a device with full rights: give them to this device at home, in Settings → Devices & phone.",
        )}
      </Note>
    );
  if (!enabled.data)
    return (
      <div className="max-w-2xl space-y-3">
        <div className="text-sm text-muted-foreground">
          {t("The terminal is off: it is a full shell as you.")}
        </div>
        <TerminalCard onChange={() => enabled.reload()} />
      </div>
    );
  if (!open)
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          {t("A shell on {name} over SSH, as its user. Every terminal opened is in the log.", {
            name,
          })}
        </div>
        <Button
          data-help="server.terminal.open"
          size="sm"
          className="gap-1"
          onClick={() => setOpen(Date.now())}
        >
          <Server className="size-3.5" />
          {t("Open a terminal on {name}", { name })}
        </Button>
      </div>
    );
  return (
    <div className="h-[60dvh] min-h-64 md:h-full">
      <Term key={open} target={id} focused visible onExit={() => setOpen(0)} />
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      {children}
    </div>
  );
}

/** Where a terminal opens: cards for this computer and each server. */
function Targets({
  servers,
  onPick,
}: {
  servers: { id: string; name: string; user: string; host: string }[];
  onPick: (id: string) => void;
}) {
  const cards = [
    { id: "local", name: t("This computer"), sub: t("A shell as you, here"), icon: Laptop },
    ...servers.map((s) => ({ id: s.id, name: s.name, sub: `${s.user}@${s.host}`, icon: Server })),
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(c.id)}
          className="flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent"
        >
          <c.icon className="mt-0.5 size-5 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{c.name}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">{c.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Enough of a WebSocket for a terminal through the loader's tunnel. */
class RemoteTerm {
  readonly OPEN = 1;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly #conn: { send(f: string): void; close(): void };
  constructor(
    t: NonNullable<ReturnType<typeof remote>>,
    target: string,
    cols: number,
    rows: number,
  ) {
    this.#conn = t.openTerm(
      { target, cols, rows },
      {
        onData: (d) => this.onmessage?.({ data: d }),
        onClose: () => {
          this.readyState = 3;
          this.onclose?.();
        },
      },
    );
  }
  send(f: string) {
    this.#conn.send(f);
  }
  close() {
    this.#conn.close();
  }
}

function Term({
  target,
  focused,
  visible,
  onExit,
}: {
  target: string;
  focused: boolean;
  visible: boolean;
  onExit: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ focus(): void; fit(): void } | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [error, setError] = useState<unknown>();
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    // xterm.js only on this page: loaded when a terminal opens.
    // The font first, so the terminal measures its cells in it.
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      document.fonts?.load('13px "JetBrains Mono Variable"').catch(() => []),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !box.current) return;
        const term = new Terminal({
          cursorBlink: true,
          fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          // Ink, whatever the theme: a terminal stays dark (the mark's own ground).
          theme: {
            background: "#0e0c16",
            foreground: "#e7e4f2",
            cursor: "#f4a73a",
            cursorAccent: "#0e0c16",
            selectionBackground: "#8f7cff55",
          },
          // A link printed in the terminal opens only as a web page, never as script (Audit 2).
          linkHandler: {
            activate: (_e, uri) => {
              try {
                const u = new URL(uri);
                if (u.protocol === "https:" || u.protocol === "http:")
                  window.open(u.href, "_blank", "noopener,noreferrer");
              } catch {}
            },
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(box.current);
        fit.fit();
        const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term?target=${encodeURIComponent(target)}&cols=${term.cols}&rows=${term.rows}&token=${auth.token() ?? ""}&unlock=${encodeURIComponent(unlock.get() ?? "")}`;
        // Away from home, through the tunnel (ADR-030); here, the daemon's own socket.
        const via = remote();
        const ws = via ? new RemoteTerm(via, target, term.cols, term.rows) : new WebSocket(url);
        ws.onmessage = (e: { data: unknown }) => term.write(String(e.data));
        ws.onclose = () => {
          setClosed(true);
          term.write("\r\n\x1b[2m[closed]\x1b[0m\r\n");
        };
        ws.onerror = () => setError(new Error(t("The terminal couldn't connect.")));
        const send = (d: string) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "in", d }));
        };
        const input = term.onData(send);
        // Copy on select (Web-UI → Terminal).
        const select = term.onSelectionChange(() => {
          const s = term.getSelection();
          if (s) void navigator.clipboard?.writeText(s).catch(() => {});
        });
        const resize = () => {
          if (!box.current?.offsetParent) return;
          fit.fit();
          if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        };
        const observer = new ResizeObserver(resize);
        observer.observe(box.current);
        // Ctrl+Shift+V pastes into the terminal that has the focus.
        const paste = (e: Event) => {
          if (focusedRef.current) send(String((e as CustomEvent).detail ?? ""));
        };
        window.addEventListener("oraknid-paste", paste);
        termRef.current = { focus: () => term.focus(), fit: resize };
        term.focus();
        cleanup = () => {
          window.removeEventListener("oraknid-paste", paste);
          observer.disconnect();
          input.dispose();
          select.dispose();
          ws.close();
          term.dispose();
        };
      })
      .catch(setError);
    return () => {
      disposed = true;
      cleanup();
    };
  }, [target]);

  useEffect(() => {
    if (focused && visible) {
      termRef.current?.fit();
      termRef.current?.focus();
    }
  }, [focused, visible]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-1 rounded-lg border bg-[#0e0c16] p-1.5",
        focused && "ring-1 ring-primary/60",
      )}
    >
      <ErrorNote error={error} />
      <section ref={box} className="min-h-0 flex-1 overflow-hidden" aria-label={t("Terminal")} />
      {closed ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          {t("Closed.")}
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onExit}>
            {t("Close the tab")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
