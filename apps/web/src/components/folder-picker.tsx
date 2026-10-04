import type { FolderList } from "@oraknid/contracts";
import {
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Home,
  Link2,
  Lock,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ErrorNote, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A path's folders from `/`, each with the path that opens it. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [
    { name: "/", path: "/" },
    ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` })),
  ];
}

/**
 * The folder picker (Web-UI → The folder picker, 2026-10-04): this
 * machine's folders, listed by the daemon, so a folder is chosen in the
 * browser (a browser can't give a full path, and from a phone the folder is
 * on the computer). Breadcrumbs, up, home, a repo marked, a new folder, and
 * a typed path for who knows it.
 */
export function FolderPicker({
  open,
  onOpenChange,
  start,
  title = t("Choose a folder"),
  description,
  choose = t("Choose this folder"),
  onChoose,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Where it opens; my home when empty or not there. */
  start?: string;
  title?: string;
  description?: ReactNode;
  choose?: string;
  onChoose: (path: string, list: FolderList) => void;
}) {
  const [list, setList] = useState<FolderList>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState("");
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const asked = useRef(0);

  const load = useCallback(async (path: string | undefined, hidden: boolean, fallback = false) => {
    const n = ++asked.current;
    setLoading(true);
    try {
      const l = await api.files.folders({ ...(path ? { path } : {}), showHidden: hidden });
      if (n !== asked.current) return;
      setList(l);
      setTyped(l.path);
      setError(undefined);
    } catch (e) {
      if (n !== asked.current) return;
      // Where it was to open isn't there (any more): my home, and why.
      if (fallback && path) {
        await load(undefined, hidden);
        setError(e);
        return;
      }
      setError(e);
    } finally {
      if (n === asked.current) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens where it starts, each time it opens
  useEffect(() => {
    if (!open) return;
    setNaming(false);
    setNewName("");
    void load(start?.trim() || undefined, showHidden, true);
  }, [open]);

  const go = (path: string | undefined) => {
    setNaming(false);
    void load(path, showHidden);
  };

  const makeFolder = async () => {
    if (!list || !newName.trim()) return;
    try {
      const made = await api.files.makeFolder({ parent: list.path, name: newName.trim() });
      setNaming(false);
      setNewName("");
      go(made.path);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? t("A folder on the computer Oraknid runs on.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <nav
            aria-label={t("Where you are")}
            className="flex flex-wrap items-center gap-0.5 font-mono text-xs"
          >
            {list
              ? crumbs(list.path).map((c, i, all) => (
                  <span key={c.path} className="flex items-center">
                    {i > 1 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
                    <button
                      type="button"
                      className={cn(
                        "rounded px-1 py-0.5 hover:bg-accent",
                        i === all.length - 1 && "font-semibold",
                      )}
                      onClick={() => go(c.path)}
                    >
                      {c.name}
                    </button>
                  </span>
                ))
              : null}
          </nav>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={!list?.parent}
              onClick={() => go(list?.parent ?? undefined)}
            >
              <ArrowUp className="size-4" />
              {t("Up")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => go(undefined)}
            >
              <Home className="size-4" />
              {t("Home")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={!list?.writable}
              onClick={() => setNaming((v) => !v)}
            >
              <FolderPlus className="size-4" />
              {t("New folder")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1"
              aria-pressed={showHidden}
              onClick={() => {
                setShowHidden(!showHidden);
                void load(list?.path, !showHidden);
              }}
            >
              {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              {showHidden
                ? t("Hide hidden folders")
                : list?.hidden
                  ? t("Show hidden ({n})", { n: list.hidden })
                  : t("Show hidden")}
            </Button>
          </div>
          {naming && list ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void makeFolder();
              }}
            >
              <Input
                autoFocus
                aria-label={t("New folder's name")}
                placeholder={t("Its name")}
                value={newName}
                onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9._-]/g, "-"))}
              />
              <Button type="submit" size="sm" disabled={!newName.trim()}>
                {t("Make it")}
              </Button>
            </form>
          ) : null}
          <ErrorNote error={error} />
          <div className="min-h-40 flex-1 overflow-y-auto rounded-md border" aria-busy={loading}>
            {!list && loading ? (
              <div className="p-3">
                <Loading rows={4} />
              </div>
            ) : list && list.entries.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t("No folders in here.")}</div>
            ) : (
              <ul aria-label={t("Folders")}>
                {list?.entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      disabled={!e.readable}
                      title={
                        e.readable
                          ? e.path
                          : t("Oraknid isn't allowed to look in {path}.", { path: e.path })
                      }
                      className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:py-3"
                      onClick={() => go(e.path)}
                    >
                      {e.isGitRepo ? (
                        <FolderGit2 className="size-4 shrink-0 text-primary" />
                      ) : (
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {e.symlink ? (
                        <Link2
                          className="size-3.5 text-muted-foreground"
                          aria-label={t("a link")}
                        />
                      ) : null}
                      {e.isGitRepo ? <Badge variant="secondary">{t("git")}</Badge> : null}
                      {e.readable ? null : (
                        <Lock
                          className="size-3.5 text-muted-foreground"
                          aria-label={t("not allowed")}
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {list?.truncated ? (
            <div className="text-xs text-muted-foreground">
              {t("Only the first 1,000 folders are listed: type the path for one further down.")}
            </div>
          ) : null}
          <form
            className="space-y-1"
            onSubmit={(e) => {
              e.preventDefault();
              go(typed.trim() || undefined);
            }}
          >
            <Label htmlFor="folder-typed" className="text-xs text-muted-foreground">
              {t("Or type a path")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="folder-typed"
                className="font-mono text-xs"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="~/code"
              />
              <Button type="submit" size="sm" variant="secondary">
                {t("Go")}
              </Button>
            </div>
          </form>
        </div>
        <DialogFooter className="items-center gap-2">
          {list ? (
            <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:text-left">
              {list.path}
              {list.isGitRepo ? ` · ${t("a git repo")}` : ""}
            </div>
          ) : null}
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!list || loading}
            onClick={() => {
              if (!list) return;
              onChoose(list.path, list);
              onOpenChange(false);
            }}
          >
            <FolderOpen className="size-4" />
            {choose}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A folder on this machine: chosen with the picker, or typed (a full path,
 * or `~/…`). Used wherever the web app asks for one.
 */
export function FolderField({
  id,
  label,
  value,
  onChange,
  title,
  description,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (path: string) => void;
  /** The picker's title. */
  title?: string;
  description?: ReactNode;
  help?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="min-w-0 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("Choose a folder, or type its path")}
        />
        <FolderPickerButton
          value={value}
          onChoose={onChange}
          title={title ?? label}
          description={description}
          label={label}
        />
      </div>
      {help}
    </div>
  );
}

/** "Choose…": the picker, opened where `value` is, giving back the folder chosen. */
export function FolderPickerButton({
  value,
  onChoose,
  title,
  description,
  label,
}: {
  value: string;
  onChoose: (path: string) => void;
  title: string;
  description?: ReactNode;
  /** What the button chooses, for a screen reader. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="shrink-0 gap-1"
        onClick={() => setOpen(true)}
        aria-label={t("Choose {label}", { label: label.toLowerCase() })}
      >
        <FolderOpen className="size-4" />
        {t("Choose…")}
      </Button>
      <FolderPicker
        open={open}
        onOpenChange={setOpen}
        start={value}
        title={title}
        description={description}
        onChoose={(path) => onChoose(path)}
      />
    </>
  );
}
