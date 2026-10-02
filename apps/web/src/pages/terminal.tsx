import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, auth } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { unlock } from "@/lib/lock";
import { remote } from "@/lib/remote";

/**
 * The terminal (ADR-028): xterm.js on this computer or on one of my
 * servers, through /term. Off until turned on in Settings.
 */
export function TerminalPage({ target = "local" }: { target?: string }) {
  const [, go] = useLocation();
  const enabled = useLive(() => api.settings.terminal(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const servers = useLive(() => api.servers.list(), { topics: ["overview"] });
  if (enabled.loading) return <Loading />;
  const choices = [
    { id: "local", label: t("This computer") },
    ...(servers.data ?? []).map((s) => ({ id: s.id, label: `${s.name} (${s.user}@${s.host})` })),
  ];
  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-0 flex-col gap-3 md:h-[calc(100dvh-5rem)]">
      <PageHeader
        title={t("Terminal")}
        sub={t("A shell in the page: on this computer, or on one of your servers.")}
        actions={
          <Select
            value={target}
            onValueChange={(v) => go(v === "local" ? "/terminal" : `/terminal/${v}`)}
          >
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {remote() ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("The terminal isn't available away from home yet: open Oraknid on this computer.")}
        </div>
      ) : !enabled.data ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("The terminal is off: it is a full shell as you.")}{" "}
          <Link href="/settings/security" className="underline">
            {t("Turn it on in Settings")}
          </Link>
          .
        </div>
      ) : (
        <Term key={target} target={target} />
      )}
    </div>
  );
}

function Term({ target }: { target: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>();
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    // xterm.js only on this page: loaded when a terminal opens.
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !box.current) return;
        const term = new Terminal({
          cursorBlink: true,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          theme: { background: "#0b0d12" },
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
        const ws = new WebSocket(url);
        ws.onmessage = (e) => term.write(String(e.data));
        ws.onclose = () => {
          setClosed(true);
          term.write("\r\n\x1b[2m[closed]\x1b[0m\r\n");
        };
        ws.onerror = () => setError(new Error(t("The terminal couldn't connect.")));
        const input = term.onData((d) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "in", d }));
        });
        const resize = () => {
          fit.fit();
          if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        };
        const observer = new ResizeObserver(resize);
        observer.observe(box.current);
        term.focus();
        cleanup = () => {
          observer.disconnect();
          input.dispose();
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
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ErrorNote error={error} />
      <section
        ref={box}
        className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-[#0b0d12] p-2"
        aria-label={t("Terminal")}
      />
      {closed ? (
        <div className="text-xs text-muted-foreground">
          {t("Closed. Choose a target again to reopen.")}
        </div>
      ) : null}
    </div>
  );
}
