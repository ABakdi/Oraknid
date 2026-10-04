import type { UpdatesView } from "@oraknid/contracts";
import { ArrowUpCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Loading, Markdown } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// Oraknid's own updates (ADR-048): a word in the sidebar, a note on the
// Overview, and Settings → About & updates.

/** The view, kept current: reloaded on every `update.*` event. */
export function useUpdates() {
  return useLive(() => api.updates.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("update."),
  });
}

/** In a few words: up to date, an update and to what, or an update running. */
export function updateLabel(v: UpdatesView): {
  text: string;
  tone: "ok" | "update" | "running" | "unknown";
} {
  if (v.run?.state === "running") return { text: t("Updating…"), tone: "running" };
  if (v.available) {
    const newest = v.newer[0];
    if (v.install.mode === "script" && v.install.channel === "dev" && !newest)
      return {
        text: t("New work on dev ({n})", { n: v.devAhead?.count ?? 0 }),
        tone: "update",
      };
    return {
      text: t("Update available: {tag}", { tag: newest?.tag ?? v.target ?? "" }),
      tone: "update",
    };
  }
  if (v.checkedAt === null) return { text: t("Not checked yet"), tone: "unknown" };
  return { text: t("Up to date"), tone: "ok" };
}

/** The sidebar's footer: the version, and whether there is an update. */
export function UpdateBadge({ view, folded }: { view: UpdatesView; folded?: boolean }) {
  const { text, tone } = updateLabel(view);
  const dot = (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "update"
          ? "bg-eye"
          : tone === "running"
            ? "animate-pulse bg-warning"
            : tone === "ok"
              ? "bg-success"
              : "bg-muted-foreground/40",
      )}
    />
  );
  return (
    <Link
      href="/settings/about"
      data-help="nav.version"
      data-update={tone}
      title={`Oraknid ${view.version} · ${text}`}
      aria-label={`Oraknid ${view.version} · ${text}`}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground outline-none hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        folded && "justify-center px-0",
      )}
    >
      {dot}
      {folded ? null : (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate">Oraknid {view.version}</span>
          <span className={cn("truncate", tone === "update" && "font-medium text-foreground")}>
            {text}
          </span>
        </span>
      )}
    </Link>
  );
}

/** The sidebar's footer, loaded. */
export function SidebarUpdate({ folded }: { folded?: boolean }) {
  const u = useUpdates();
  return u.data ? <UpdateBadge view={u.data} folded={folded} /> : null;
}

/** The Overview's note when there is an update to install. */
export function UpdateNotice() {
  const u = useUpdates();
  const v = u.data;
  if (!v?.available || v.install.mode !== "script" || v.run?.state === "running") return null;
  const { text } = updateLabel(v);
  return (
    <Link
      href="/settings/about"
      data-help="overview.update"
      className="flex items-center gap-2 rounded-xl border border-eye/40 bg-eye/10 px-3 py-2 text-sm hover:bg-eye/15"
    >
      <ArrowUpCircle className="size-4 shrink-0 text-eye" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{text}</span>
        <span className="text-muted-foreground"> · {t("see what's new and update")}</span>
      </span>
    </Link>
  );
}

export interface UpdatesPanelProps {
  view: UpdatesView;
  checking?: boolean;
  /** The daemon doesn't answer: it is restarting. */
  restarting?: boolean;
  /** The version this page was loaded from: a newer one needs a reload. */
  pageVersion?: string;
  onCheck?: () => void;
  onUpdate?: () => void;
  onReload?: () => void;
  now?: number;
}

/** Settings → About & updates, drawn from the view. */
export function UpdatesPanel({
  view: v,
  checking,
  restarting,
  pageVersion,
  onCheck,
  onUpdate,
  onReload,
  now = Date.now(),
}: UpdatesPanelProps) {
  const i = v.install;
  const run = v.run;
  const label = updateLabel(v);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>Oraknid {v.version}</span>
          {i.mode === "script" ? (
            <Badge variant="outline" data-channel={i.channel}>
              {i.channel === "dev" ? t("dev channel") : t("stable channel")}
            </Badge>
          ) : (
            <Badge variant="outline">
              {i.unrecorded ? t("installed before the record") : t("from a clone")}
            </Badge>
          )}
          <Badge
            data-state={label.tone}
            className={cn(
              label.tone === "update" && "bg-eye text-eye-foreground",
              label.tone === "ok" && "bg-success/15 text-success",
              label.tone !== "update" && label.tone !== "ok" && "bg-muted text-muted-foreground",
            )}
          >
            {label.text}
          </Badge>
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">
          {i.mode === "script"
            ? t("Installed by install.sh from {ref}, in {dir}. {which}", {
                ref: i.ref,
                dir: i.appDir,
                which:
                  i.channel === "dev"
                    ? t("Pre-releases and new work on dev count as updates.")
                    : t("Releases count as updates; pre-releases don't."),
              })
            : i.unrecorded
              ? (v.whyNot ?? "")
              : t(
                  "Running from a clone at {dir}: update it with git (git pull, pnpm install, pnpm build).",
                  {
                    dir: i.appDir,
                  },
                )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground" data-checked>
            {v.checkedAt
              ? t("Last checked {when}", { when: ago(v.checkedAt, now) })
              : t("Not checked yet")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            data-help="settings.check-updates"
            disabled={checking}
            onClick={onCheck}
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("Check now")}
          </Button>
        </div>
        {v.error ? (
          <div role="status" className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
            {v.error}
          </div>
        ) : null}

        {v.newer.length ? (
          <section className="space-y-2" aria-label={t("What's new")}>
            {v.newer.map((r, n) => (
              <details
                key={r.tag}
                open={n === 0}
                className="rounded-lg border px-3 py-2"
                data-release={r.tag}
              >
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{r.tag}</span>
                  {r.prerelease ? <Badge variant="outline">{t("pre-release")}</Badge> : null}
                  {r.name !== r.tag ? (
                    <span className="text-muted-foreground">{r.name}</span>
                  ) : null}
                  {r.publishedAt ? (
                    <span className="text-xs text-muted-foreground">{ago(r.publishedAt, now)}</span>
                  ) : null}
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary"
                  >
                    {t("On GitHub")}
                    <ExternalLink className="size-3" />
                  </a>
                </summary>
                <div className="pt-2">
                  {r.notes.trim() ? (
                    <Markdown text={r.notes} />
                  ) : (
                    <div className="text-sm text-muted-foreground">{t("No notes.")}</div>
                  )}
                </div>
              </details>
            ))}
          </section>
        ) : null}

        {v.devAhead && v.devAhead.count > 0 ? (
          <section
            className="space-y-1 rounded-lg border px-3 py-2"
            data-dev-ahead={v.devAhead.count}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {t("New work on dev ({n} commits)", { n: v.devAhead.count })}
              </span>
              <a
                href={v.devAhead.url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs text-primary"
              >
                {t("On GitHub")}
                <ExternalLink className="size-3" />
              </a>
            </div>
            <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
              {v.devAhead.commits.slice(0, 10).map((c) => (
                <li key={c.sha} className="truncate">
                  {c.sha.slice(0, 7)} {c.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {run ? (
          <RunBlock
            view={v}
            restarting={restarting}
            pageVersion={pageVersion}
            onReload={onReload}
            now={now}
          />
        ) : null}

        {i.mode === "script" && v.available && run?.state !== "running" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-help="settings.update-now"
              disabled={!v.canUpdate}
              onClick={onUpdate}
              className="gap-1.5"
            >
              <ArrowUpCircle className="size-4" />
              {v.target === "dev"
                ? t("Update now to the newest dev")
                : t("Update now to {tag}", { tag: v.target ?? "" })}
            </Button>
            {v.whyNot ? (
              <span className="text-sm text-muted-foreground">{v.whyNot}</span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {t("Your data is kept; Oraknid copies its database first and restarts.")}
              </span>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RunBlock({
  view: v,
  restarting,
  pageVersion,
  onReload,
  now,
}: {
  view: UpdatesView;
  restarting?: boolean;
  pageVersion?: string;
  onReload?: () => void;
  now: number;
}) {
  const run = v.run;
  if (!run) return null;
  const headline =
    run.state === "running"
      ? restarting
        ? t("Updating to {target}: Oraknid is restarting…", { target: run.target })
        : t("Updating to {target}…", { target: run.target })
      : run.state === "succeeded"
        ? t("Updated to {version}", {
            version: run.toVersion ? `v${run.toVersion}` : run.target,
          })
        : run.state === "rolled-back"
          ? t("The update to {target} failed; Oraknid went back to v{from}.", {
              target: run.target,
              from: run.fromVersion,
            })
          : run.state === "interrupted"
            ? t("The update to {target} stopped without a word (was the computer stopped?).", {
                target: run.target,
              })
            : t("The update to {target} failed.", { target: run.target });
  const stale = run.state === "succeeded" && pageVersion && pageVersion !== v.version;
  return (
    <section
      className={cn(
        "space-y-2 rounded-lg border px-3 py-2",
        run.state === "failed" || run.state === "rolled-back" || run.state === "interrupted"
          ? "border-destructive/40"
          : run.state === "succeeded"
            ? "border-success/40"
            : "",
      )}
      data-run={run.state}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {run.state === "running" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : run.state === "succeeded" ? (
          <CheckCircle2 className="size-4 text-success" />
        ) : null}
        <span className="font-medium">{headline}</span>
        <span className="text-xs text-muted-foreground">
          {t("started {when}", { when: ago(run.startedAt, now) })}
        </span>
        {stale ? (
          <Button size="sm" className="ml-auto" onClick={onReload}>
            {t("Reload the page")}
          </Button>
        ) : null}
      </div>
      {run.backup ? (
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t("The database was copied first to {file}.", { file: run.backup })}
        </div>
      ) : null}
      {run.log.length ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]">
          {run.log.slice(-60).join("\n")}
        </pre>
      ) : null}
    </section>
  );
}

/**
 * The card in Settings: Check now, Update now with a confirm, and the
 * update followed across the restart (polled; a daemon that doesn't answer
 * is restarting).
 */
export function UpdatesCard() {
  const s = useUpdates();
  const [polled, setPolled] = useState<UpdatesView | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const pageVersion = useRef<string | undefined>(undefined);
  const { confirm, dialog } = useConfirm();
  // Fresh data from an event wins over what was polled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new load replaces the polled view
  useEffect(() => setPolled(null), [s.data]);
  const v = polled ?? s.data;
  if (v && pageVersion.current === undefined) pageVersion.current = v.version;
  const following = v?.run?.state === "running";

  useEffect(() => {
    if (!following) return;
    const id = setInterval(() => {
      api.updates
        .status()
        .then((next) => {
          setRestarting(false);
          setPolled(next);
        })
        .catch(() => setRestarting(true));
    }, 2000);
    return () => clearInterval(id);
  }, [following]);

  if (s.error && !v) return <div className="text-sm text-destructive">{message(s.error)}</div>;
  if (!v) return <Loading rows={2} />;

  const check = async () => {
    setChecking(true);
    try {
      setPolled(await api.updates.check());
    } catch (e) {
      toast.error(message(e));
    } finally {
      setChecking(false);
    }
  };
  const update = async () => {
    const jobs = v.runningJobs;
    const ok = await confirm(
      t("Update Oraknid?"),
      <>
        <p>
          {v.target === "dev"
            ? t("Oraknid installs the newest work on dev.")
            : t("Oraknid installs {tag}.", { tag: v.target ?? "" })}{" "}
          {t(
            "It copies its database first, then fetches, builds and restarts; your data, projects and settings stay as they are.",
          )}
        </p>
        {jobs ? (
          <p className="font-medium text-foreground">
            {t(
              "{n} job(s) running: they pause at a safe point while Oraknid restarts, and go on after it.",
              { n: jobs },
            )}
          </p>
        ) : null}
        <p>{t("This page follows the update and reconnects by itself.")}</p>
      </>,
      t("Update now"),
      { safe: true },
    );
    if (!ok) return;
    try {
      const run = await api.updates.run({ confirm: jobs > 0 });
      setPolled({ ...v, run, canUpdate: false });
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <>
      <UpdatesPanel
        view={v}
        checking={checking}
        restarting={restarting}
        pageVersion={pageVersion.current}
        onCheck={() => void check()}
        onUpdate={() => void update()}
        onReload={() => location.reload()}
      />
      {dialog}
    </>
  );
}
