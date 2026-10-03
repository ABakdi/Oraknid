import { Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { BackButton, Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { ToolsSetupButton } from "@/components/setup";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

type SkillFull = Awaited<ReturnType<typeof api.skills.get>>;

const TEMPLATE =
  "---\nname: my-skill\ndescription: One line.\ninterview: false\n---\n\n# My method\n";

/** A skill as markdown again, with every field the front matter can hold (Skills → Format). */
function asMarkdown(s: SkillFull): string {
  const lines = [
    "---",
    `name: ${s.name}`,
    `description: ${s.description}`,
    `interview: ${s.interview}`,
  ];
  if (s.requiredTools.length) {
    lines.push("requires:", "  tools:", ...s.requiredTools.map((x) => `    - ${x}`));
  }
  if (s.verify.length) lines.push("verify:", ...s.verify.map((x) => `  - ${x}`));
  lines.push("---", "", s.body);
  return lines.join("\n");
}

/**
 * The skill library (Web-UI → Skills): the list beside the open skill, its
 * id in the address; on a phone one at a time, with a way back.
 */
export function SkillsPage({ id }: { id?: string }) {
  const [, go] = useLocation();
  const skills = useLive(() => api.skills.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("skill."),
  });
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    markdown: string;
  } | null>(null);
  if (skills.error) return <ErrorNote error={skills.error} />;
  if (skills.loading) return <Loading />;
  const list = skills.data ?? [];
  const selected = list.find((s) => s.id === id);
  // On a computer the first one is open by default; on a phone the list comes first.
  const shown =
    selected ?? (typeof window !== "undefined" && window.innerWidth >= 1024 ? list[0] : undefined);
  const save = async () => {
    if (!editing) return;
    try {
      const r = editing.id
        ? await api.skills.edit({ id: editing.id, markdown: editing.markdown })
        : await api.skills.upload({ name: editing.name || "skill", markdown: editing.markdown });
      // Never refused for its front matter: what was ignored is said (Skills → Format).
      if (r.ignored.length) toast.warning(r.ignored.join(" "));
      else toast.success(t("Saved as version {v}.", { v: r.skill.version }));
      setEditing(null);
      skills.reload();
      go(`/skills/${r.skill.id}`, { replace: !!selected });
    } catch (e) {
      toast.error(message(e));
    }
  };
  const create = (
    <Button
      className="gap-1"
      onClick={() => setEditing({ id: null, name: "", markdown: TEMPLATE })}
    >
      <Plus className="size-4" />
      {t("New or upload")}
    </Button>
  );
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("Skills")}
        sub={t("Methods a job follows. Jobs keep the version they started with.")}
        actions={create}
      />
      {list.length === 0 ? (
        <Empty title={t("No skills")} action={create}>
          {t("A skill is a method in markdown: how to plan, what to check, which tools it needs.")}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav
            aria-label={t("Skills")}
            className={cn("min-w-0 space-y-1", selected && "hidden lg:block")}
          >
            {list.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(`/skills/${s.id}`, { replace: !!selected })}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left hover:bg-accent",
                  s.id === shown?.id ? "border-primary bg-accent" : "bg-card",
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <span className="min-w-0 truncate" title={s.name}>
                    {s.name}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {s.source === "built-in" ? t("built-in") : `v${s.version}`}
                  </Badge>
                </div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>
              </button>
            ))}
          </nav>
          {shown ? (
            <div className={cn("min-w-0", !selected && "hidden lg:block")}>
              <SkillDetail
                key={shown.id}
                id={shown.id}
                latest={shown.version}
                onEdit={(s) => setEditing({ id: s.id, name: s.name, markdown: asMarkdown(s) })}
                onGone={() => {
                  skills.reload();
                  go("/skills", { replace: true });
                }}
              />
            </div>
          ) : null}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("Edit the skill") : t("New skill")}</DialogTitle>
            <DialogDescription>
              {t(
                "Markdown with optional front matter: name, description, interview, requires.tools, verify.",
              )}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <Tabs defaultValue="write">
              <TabsList>
                <TabsTrigger value="write">{t("Write")}</TabsTrigger>
                <TabsTrigger value="preview">{t("Preview")}</TabsTrigger>
              </TabsList>
              <TabsContent value="write" className="space-y-2">
                {!editing.id ? (
                  <Input
                    placeholder={t("Name (if the front matter has none)")}
                    aria-label={t("Name")}
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild variant="secondary" size="sm" className="gap-1">
                    <label className="cursor-pointer">
                      <Upload className="size-3.5" />
                      {t("Upload a .md file")}
                      <input
                        type="file"
                        accept=".md,.markdown,text/markdown"
                        className="sr-only"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (f) setEditing({ ...editing, ...(await fromFile(f)) });
                        }}
                      />
                    </label>
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("or paste it below, or drop a file on it")}
                  </span>
                </div>
                <Textarea
                  rows={16}
                  aria-label={t("The skill, in markdown")}
                  className="font-mono text-xs"
                  value={editing.markdown}
                  onChange={(e) => setEditing({ ...editing, markdown: e.target.value })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={async (e) => {
                    const f = e.dataTransfer.files[0];
                    if (!f) return;
                    e.preventDefault();
                    setEditing({ ...editing, ...(await fromFile(f)) });
                  }}
                />
              </TabsContent>
              <TabsContent value="preview" className="max-h-[60dvh] overflow-y-auto">
                <Markdown text={editing.markdown.replace(/^---[\s\S]*?---\n/, "")} />
              </TabsContent>
            </Tabs>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t("Cancel")}
            </Button>
            <Button disabled={!editing?.markdown.trim()} onClick={save}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One skill: rendered, its tools, its earlier versions; edit and delete when it is mine. */
function SkillDetail({
  id,
  latest,
  onEdit,
  onGone,
}: {
  id: string;
  latest: number;
  onEdit: (s: SkillFull) => void;
  onGone: () => void;
}) {
  const [version, setVersion] = useState<number | null>(null);
  const skill = useLive(() => api.skills.get({ id, ...(version ? { version } : {}) }), {
    topics: [],
    deps: [id, version, latest],
  });
  const tools = useLive(() => api.tools.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("tool."),
  });
  const { confirm, dialog } = useConfirm();
  if (skill.error) return <ErrorNote error={skill.error} />;
  if (!skill.data) return <Loading rows={4} />;
  const s = skill.data;
  const ready = new Set(
    (tools.data ?? []).filter((x) => !x.missingSecrets.length).map((x) => x.name),
  );
  const missing = s.requiredTools.filter((x) => !ready.has(x));
  const remove = async () => {
    if (
      !(await confirm(
        t("Delete “{name}”?", { name: s.name }),
        t("It leaves the library with all its versions. Jobs that already use it keep their copy."),
        t("Delete"),
        { keep: t("Keep it") },
      ))
    )
      return;
    try {
      await api.skills.remove({ id: s.id });
      toast.success(t("Deleted."));
      onGone();
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <BackButton fallback="/skills" label={t("All skills")} className="lg:hidden" />
        <h2 className="min-w-0 truncate text-lg font-semibold" title={s.name}>
          {s.name}
        </h2>
        {s.interview ? <Badge variant="secondary">{t("interviews first")}</Badge> : null}
        <span className="flex-1" />
        {s.source === "uploaded" && latest > 1 ? (
          <Select
            value={String(version ?? latest)}
            onValueChange={(v) => setVersion(Number(v) === latest ? null : Number(v))}
          >
            <SelectTrigger className="h-8 w-32" aria-label={t("Version")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: latest }, (_, i) => latest - i).map((v) => (
                <SelectItem key={v} value={String(v)}>
                  {v === latest ? t("v{v} (latest)", { v }) : `v${v}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {s.source === "uploaded" ? (
          <>
            <Button size="sm" variant="secondary" className="gap-1" onClick={() => onEdit(s)}>
              <Pencil className="size-3.5" />
              {version ? t("Edit from this version") : t("Edit")}
            </Button>
            <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={remove}>
              <Trash2 className="size-3.5" />
              {t("Delete")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            title={t("Built-ins are read-only; a copy is yours to change.")}
            onClick={() => onEdit({ ...s, id: "", name: `${s.name}-mine` })}
          >
            <Pencil className="size-3.5" />
            {t("Make a copy to change")}
          </Button>
        )}
      </div>
      {s.description ? <p className="text-sm text-muted-foreground">{s.description}</p> : null}
      {s.requiredTools.length || s.verify.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {s.requiredTools.length ? (
            <span className="text-muted-foreground">{t("Uses:")}</span>
          ) : null}
          {s.requiredTools.map((n) => (
            <Badge key={n} variant={ready.has(n) ? "outline" : "destructive"}>
              {ready.has(n) ? n : t("{tool} (not set up)", { tool: n })}
            </Badge>
          ))}
          {missing.length ? <ToolsSetupButton missing={missing} /> : null}
          {s.verify.length ? (
            <span className="text-muted-foreground">
              {t("Checks: {c}", { c: s.verify.join(" · ") })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="max-h-[65dvh] overflow-y-auto">
        <Markdown text={s.body} />
      </div>
      {dialog}
    </section>
  );
}

/** A skill from a markdown file: its text, and its name from the file's. */
async function fromFile(f: File) {
  return { name: f.name.replace(/\.(md|markdown)$/i, ""), markdown: await f.text() };
}
