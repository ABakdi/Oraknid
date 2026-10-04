import type { ProjectView, RemovalPreview, RemovalResult, RemovalStep } from "@oraknid/contracts";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ErrorNote, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api, message } from "@/lib/api";
import { bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useEvents } from "@/lib/live";
import { cn } from "@/lib/utils";

// Archiving and deleting a project with my choices (Jobs-and-Projects →
// Archiving and deleting a project, Web-UI → Projects): what goes is
// ticked in a dialog, a folder or a GitHub repo needs its name typed, and
// the result says each step, done or not.

export type RemovalKind = "archive" | "delete";

/**
 * The project's "…" menu: Archive (or Unarchive) and Delete, in its
 * header and on its card in the list.
 */
export function ProjectMenu({
  project,
  className,
  help,
}: {
  project: ProjectView;
  className?: string;
  help?: string;
}) {
  const [open, setOpen] = useState<RemovalKind | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-help={help}
            size="sm"
            variant="ghost"
            className={cn("shrink-0 px-2", className)}
            aria-label={t("Actions for {name}", { name: project.name })}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => setOpen("archive")}>
            {project.archivedAt ? (
              <ArchiveRestore className="size-3.5" />
            ) : (
              <Archive className="size-3.5" />
            )}
            {project.archivedAt ? t("Unarchive…") : t("Archive…")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => setOpen("delete")}>
            <Trash2 className="size-3.5" />
            {t("Delete…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectRemovalDialog
        project={project}
        kind={open}
        onOpenChange={(o) => !o && setOpen(null)}
      />
    </>
  );
}

/** The dialog for one of them: Archive or Unarchive (by the project's state), or Delete. */
export function ProjectRemovalDialog({
  project,
  kind,
  onOpenChange,
}: {
  project: ProjectView;
  kind: RemovalKind | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!kind} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "delete" ? (
          <DeleteBody project={project} close={() => onOpenChange(false)} />
        ) : kind === "archive" && project.archivedAt ? (
          <UnarchiveBody project={project} close={() => onOpenChange(false)} />
        ) : kind === "archive" ? (
          <ArchiveBody project={project} close={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** What deleting or archiving would touch, read when the dialog opens. */
function usePreview(id: string) {
  const [data, setData] = useState<RemovalPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api.projects
      .removalPreview({ id })
      .then((p) => live && setData(p))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [id]);
  return { data, error };
}

/** A checkbox with its words, and why it can't be ticked when it can't. */
function Choice({
  checked,
  onChange,
  disabled,
  label,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
  children?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        disabled ? "opacity-70" : "cursor-pointer hover:bg-accent/50",
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="min-w-0 space-y-1">
        <span className="block font-medium">{label}</span>
        {children}
      </span>
    </label>
  );
}

const Note = ({ children, tone }: { children: ReactNode; tone?: "warn" }) => (
  <span
    className={cn(
      "block text-xs [overflow-wrap:anywhere]",
      tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
    )}
  >
    {children}
  </span>
);

const sizeOf = (p: RemovalPreview) =>
  p.folder.bytes === null
    ? null
    : `${p.folder.partial ? t("at least ") : ""}${bytes(p.folder.bytes)}, ${t("{n} file(s)", { n: p.folder.files })}`;

/** Its running jobs, and the choice to cancel them first (else the button stays off). */
function RunningJobs({
  preview,
  stop,
  setStop,
}: {
  preview: RemovalPreview;
  stop: boolean;
  setStop: (on: boolean) => void;
}) {
  if (!preview.runningJobs.length) return null;
  return (
    <Choice checked={stop} onChange={setStop} label={t("Cancel its running jobs first")}>
      <Note tone="warn">
        {t("Still going: {list}. They are cancelled before anything else.", {
          list: preview.runningJobs.map((j) => j.title).join(", "),
        })}
      </Note>
    </Choice>
  );
}

/** What deleting a repo's folder would lose: changes not committed, commits not pushed. */
function lossOf(preview: RemovalPreview): string[] {
  return preview.repos.flatMap((r) => {
    const out: string[] = [];
    if (r.loss.uncommittedCount)
      out.push(
        t("{repo}: {n} file(s) not committed", { repo: r.name, n: r.loss.uncommittedCount }),
      );
    if (r.loss.unpushed.length)
      out.push(
        t("{repo}: commits not on GitHub on {branches}", {
          repo: r.name,
          branches: r.loss.unpushed.map((b) => `${b.branch} (${b.commits})`).join(", "),
        }),
      );
    if (r.loss.stashes) out.push(t("{repo}: {n} stash(es)", { repo: r.name, n: r.loss.stashes }));
    return out;
  });
}

/** The name to type: the project's, or the one GitHub repo's when that is all that goes. */
export function confirmWord(project: string, folder: boolean, repos: string[]): string | null {
  if (!folder && !repos.length) return null;
  if (!folder && repos.length === 1) return repos[0] ?? project;
  return project;
}

function TypedConfirm({
  word,
  value,
  onChange,
}: {
  word: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm" htmlFor="removal-confirm">
        {t("To confirm, type")} <code className="rounded bg-muted px-1 font-mono">{word}</code>
      </label>
      <Input
        id="removal-confirm"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("Type {word} to confirm", { word })}
      />
    </div>
  );
}

const ICON = {
  done: <CircleCheck className="size-4 shrink-0 text-emerald-600" />,
  failed: <CircleX className="size-4 shrink-0 text-destructive" />,
  skipped: <CircleMinus className="size-4 shrink-0 text-muted-foreground" />,
};

const STATUS = { done: "Done", failed: "Not done", skipped: "Skipped" } as const;

/** What was done and what wasn't, step by step. */
export function RemovalSteps({ steps }: { steps: RemovalStep[] }) {
  return (
    <ul className="space-y-2 text-sm" aria-label={t("What was done")}>
      {steps.map((s) => (
        <li key={`${s.kind}-${s.target}`} className="flex items-start gap-2">
          {ICON[s.status]}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="sr-only">{t(STATUS[s.status])}: </span>
            {s.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Result({
  result,
  title,
  close,
}: {
  result: RemovalResult;
  title: string;
  close: () => void;
}) {
  const failed = result.steps.some((s) => s.status === "failed");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {failed ? t("Some steps weren't done; each says why.") : t("Every step was done.")}
        </DialogDescription>
      </DialogHeader>
      <RemovalSteps steps={result.steps} />
      <DialogFooter>
        <Button onClick={close}>{t("Close")}</Button>
      </DialogFooter>
    </>
  );
}

function DeleteBody({ project, close }: { project: ProjectView; close: () => void }) {
  const [, go] = useLocation();
  const preview = usePreview(project.id);
  const [folder, setFolder] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [stop, setStop] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RemovalResult | null>(null);
  if (result)
    return (
      <Result
        result={result}
        title={result.kept ? t("“{name}” is still here", { name: project.name }) : t("Deleted")}
        close={() => {
          close();
          if (!result.kept) go("/projects", { replace: true });
        }}
      />
    );
  const p = preview.data;
  const word = confirmWord(project.name, folder, repos);
  const ready = !!p && (!p.runningJobs.length || stop) && (!word || typed.trim() === word);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.projects.delete({
          id: project.id,
          deleteFolder: folder,
          deleteRepos: repos,
          stopJobs: stop,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const loss = p ? lossOf(p) : [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Delete “{name}”?", { name: project.name })}</DialogTitle>
        <DialogDescription>
          {t("This can't be undone. Choose what goes; what you leave unticked stays.")}
        </DialogDescription>
      </DialogHeader>
      {preview.error ? <ErrorNote error={preview.error} /> : null}
      {!p && !preview.error ? <Loading rows={2} /> : null}
      {p ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              <span className="block font-medium">{t("Always: Oraknid's records")}</span>
              <Note>
                {t(
                  "The project and its {n} job(s) leave Oraknid with their history (tasks, sessions, Silk, logs).",
                  { n: project.jobCount },
                )}
              </Note>
            </span>
          </div>
          <RunningJobs preview={p} stop={stop} setStop={setStop} />
          <Choice
            checked={folder}
            onChange={setFolder}
            disabled={!p.folder.exists || !!p.folder.refused}
            label={t("Delete the project folder from this computer")}
          >
            <Note>
              <code className="font-mono">{p.folder.path}</code>
              {sizeOf(p) ? ` · ${sizeOf(p)}` : ""}
            </Note>
            <Note>{t("Everything in it goes, its worktrees and job branches included.")}</Note>
            {!p.folder.exists ? <Note>{t("The folder isn't there any more.")}</Note> : null}
            {p.folder.refused ? <Note tone="warn">{p.folder.refused}</Note> : null}
            {folder && loss.length ? (
              <Note tone="warn">{t("Lost with it: {list}.", { list: loss.join("; ") })}</Note>
            ) : null}
          </Choice>
          {p.repos
            .filter((r) => r.github)
            .map((r) => {
              const g = r.github as NonNullable<typeof r.github>;
              const off = !g.ready || g.owned === false || !!g.error;
              return (
                <Choice
                  key={r.name}
                  checked={repos.includes(g.fullName)}
                  onChange={(on) =>
                    setRepos((xs) =>
                      on ? [...xs, g.fullName] : xs.filter((x) => x !== g.fullName),
                    )
                  }
                  disabled={off}
                  label={t("Delete the GitHub repo {repo}", { repo: g.fullName })}
                >
                  <Note>
                    {t(
                      "On GitHub, with {account}'s token. Its issues, pull requests and history there go too.",
                      {
                        account: g.account,
                      },
                    )}
                  </Note>
                  {!g.ready ? <Note>{t("It isn't created on GitHub yet.")}</Note> : null}
                  {g.owned === false ? (
                    <Note tone="warn">
                      {t(
                        "{account} doesn't own it: Oraknid only deletes a repo the account owns.",
                        {
                          account: g.account,
                        },
                      )}
                    </Note>
                  ) : null}
                  {g.error ? <Note tone="warn">{g.error}</Note> : null}
                  {g.canDelete === false ? (
                    <Note tone="warn">
                      {t(
                        "{account}'s token hasn't the delete_repo permission: GitHub will refuse. Grant it on github.com → Settings → Developer settings → Personal access tokens, then paste the token again in Settings → Connections → GitHub.",
                        { account: g.account },
                      )}
                    </Note>
                  ) : null}
                </Choice>
              );
            })}
          {word ? <TypedConfirm word={word} value={typed} onChange={setTyped} /> : null}
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" autoFocus onClick={close}>
          {t("Keep it")}
        </Button>
        <Button variant="destructive" disabled={!ready || busy} onClick={run}>
          <Trash2 className="size-4" />
          {busy ? t("Deleting…") : t("Delete")}
        </Button>
      </DialogFooter>
    </>
  );
}

function ArchiveBody({ project, close }: { project: ProjectView; close: () => void }) {
  const preview = usePreview(project.id);
  const [folder, setFolder] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [stop, setStop] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RemovalResult | null>(null);
  if (result) return <Result result={result} title={t("Archived")} close={close} />;
  const p = preview.data;
  const word = folder ? project.name : null;
  const ready = !!p && (!p.runningJobs.length || stop) && (!word || typed.trim() === word);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.projects.archive({
          id: project.id,
          archived: true,
          archiveRepos: repos,
          deleteFolder: folder,
          stopJobs: stop,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Archive “{name}”?", { name: project.name })}</DialogTitle>
        <DialogDescription>
          {t(
            "It moves to Archived projects: hidden from the lists and New work, everything kept, and it can come back.",
          )}
        </DialogDescription>
      </DialogHeader>
      {preview.error ? <ErrorNote error={preview.error} /> : null}
      {!p && !preview.error ? <Loading rows={2} /> : null}
      {p ? (
        <div className="space-y-2">
          <RunningJobs preview={p} stop={stop} setStop={setStop} />
          {p.repos
            .filter((r) => r.github)
            .map((r) => {
              const g = r.github as NonNullable<typeof r.github>;
              const off = !g.ready || g.owned === false || g.archived === true || !!g.error;
              return (
                <Choice
                  key={r.name}
                  checked={repos.includes(g.fullName)}
                  onChange={(on) =>
                    setRepos((xs) =>
                      on ? [...xs, g.fullName] : xs.filter((x) => x !== g.fullName),
                    )
                  }
                  disabled={off}
                  label={t("Archive the GitHub repo {repo}", { repo: g.fullName })}
                >
                  <Note>
                    {t("Read-only on GitHub until it is unarchived; nothing is deleted.")}
                  </Note>
                  {g.archived ? <Note>{t("It is archived on GitHub already.")}</Note> : null}
                  {g.owned === false ? (
                    <Note tone="warn">
                      {t(
                        "{account} doesn't own it: Oraknid only archives a repo the account owns.",
                        {
                          account: g.account,
                        },
                      )}
                    </Note>
                  ) : null}
                  {g.error ? <Note tone="warn">{g.error}</Note> : null}
                </Choice>
              );
            })}
          <Choice
            checked={folder}
            onChange={setFolder}
            disabled={!p.archiveFolder.allowed}
            label={t("Delete the project folder from this computer to free space")}
          >
            <Note>
              <code className="font-mono">{p.folder.path}</code>
              {sizeOf(p) ? ` · ${sizeOf(p)}` : ""}
            </Note>
            <Note>
              {t(
                "Unarchiving clones it back from GitHub, to the same place. Offered only when every repo is pushed and nothing is uncommitted.",
              )}
            </Note>
            {p.archiveFolder.reasons.length ? (
              <span className="block space-y-0.5">
                {p.archiveFolder.reasons.map((r) => (
                  <Note key={r} tone="warn">
                    {r}
                  </Note>
                ))}
              </span>
            ) : null}
          </Choice>
          {word ? <TypedConfirm word={word} value={typed} onChange={setTyped} /> : null}
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" autoFocus onClick={close}>
          {t("Cancel")}
        </Button>
        <Button disabled={!ready || busy} onClick={run}>
          <Archive className="size-4" />
          {busy ? t("Archiving…") : t("Archive")}
        </Button>
      </DialogFooter>
    </>
  );
}

function UnarchiveBody({ project, close }: { project: ProjectView; close: () => void }) {
  const record = project.archivedWith ?? null;
  const archived = record?.githubArchived ?? [];
  const [repos, setRepos] = useState<string[]>(archived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RemovalResult | null>(null);
  const progress = useEvents(["overview"], 50).find(
    (e) =>
      e.type === "project.restoring" && (e.payload as { id?: string } | null)?.id === project.id,
  )?.payload as { repo: string; done: number; of: number; state: string } | undefined;
  if (result)
    return (
      <Result
        result={result}
        title={
          result.steps.some((s) => s.kind === "archive" && s.status === "done")
            ? t("Back in the list")
            : t("Still archived")
        }
        close={close}
      />
    );
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.projects.archive({ id: project.id, archived: false, unarchiveRepos: repos }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Unarchive “{name}”?", { name: project.name })}</DialogTitle>
        <DialogDescription>{t("It comes back in the list and New work.")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        {record?.folderDeleted ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <span className="block font-medium">{t("Its folder comes back from GitHub")}</span>
            <Note>
              {t(
                "Archiving deleted its folder: each repo is cloned back from GitHub into {path}, where it was.",
                { path: project.workspacePath },
              )}
            </Note>
          </div>
        ) : null}
        {archived.map((full) => (
          <Choice
            key={full}
            checked={repos.includes(full)}
            onChange={(on) => setRepos((xs) => (on ? [...xs, full] : xs.filter((x) => x !== full)))}
            label={t("Unarchive the GitHub repo {repo}", { repo: full })}
          >
            <Note>{t("Archiving made it read-only on GitHub; this makes it writable again.")}</Note>
          </Choice>
        ))}
        {busy && progress ? (
          <div className="text-sm text-muted-foreground" aria-live="polite">
            {t("Cloning {repo} ({done} of {of})…", {
              repo: progress.repo,
              done: Math.min(progress.done + (progress.state === "cloning" ? 1 : 0), progress.of),
              of: progress.of,
            })}
          </div>
        ) : null}
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
      </div>
      <DialogFooter>
        <Button variant="secondary" autoFocus onClick={close}>
          {t("Cancel")}
        </Button>
        <Button disabled={busy} onClick={run}>
          <ArchiveRestore className="size-4" />
          {busy
            ? record?.folderDeleted
              ? t("Bringing it back…")
              : t("Unarchiving…")
            : t("Unarchive")}
        </Button>
      </DialogFooter>
    </>
  );
}
