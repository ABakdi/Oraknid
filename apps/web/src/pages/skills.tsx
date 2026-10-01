import { Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

export function SkillsPage() {
  const skills = useLive(() => api.skills.list(), { topics: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    markdown: string;
  } | null>(null);
  const current = selected ?? skills.data?.[0]?.id ?? null;
  const skill = useLive(() => (current ? api.skills.get({ id: current }) : Promise.resolve(null)), {
    topics: [],
    deps: [current, skills.data?.length],
  });
  if (skills.error) return <ErrorNote error={skills.error} />;
  if (skills.loading) return <Loading />;
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
      setSelected(r.skill.id);
      skills.reload();
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("Skills")}
        sub={t("Methods a job follows. Jobs keep the version they started with.")}
        actions={
          <Button
            className="gap-1"
            onClick={() =>
              setEditing({
                id: null,
                name: "",
                markdown:
                  "---\nname: my-skill\ndescription: One line.\ninterview: false\n---\n\n# My method\n",
              })
            }
          >
            <Upload className="size-4" />
            {t("New or upload")}
          </Button>
        }
      />
      {(skills.data ?? []).length === 0 ? <Empty title={t("No skills")} /> : null}
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-1">
          {(skills.data ?? []).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left hover:bg-accent ${s.id === current ? "border-primary bg-accent" : "bg-card"}`}
            >
              <div className="flex items-center gap-2 font-medium">
                <span className="truncate">{s.name}</span>
                <Badge variant="outline">
                  {s.source === "built-in" ? t("built-in") : `v${s.version}`}
                </Badge>
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>
            </button>
          ))}
        </div>
        {skill.data ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {skill.data.name}
                {skill.data.interview ? (
                  <Badge variant="secondary">{t("interviews first")}</Badge>
                ) : null}
                <span className="flex-1" />
                {skill.data.source === "uploaded" ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setEditing({
                          id: skill.data?.id ?? null,
                          name: skill.data?.name ?? "",
                          markdown: `---\nname: ${skill.data?.name}\ndescription: ${skill.data?.description}\ninterview: ${skill.data?.interview}\n---\n\n${skill.data?.body}`,
                        })
                      }
                    >
                      {t("Edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={async () => {
                        try {
                          await api.skills.remove({ id: skill.data?.id as string });
                          setSelected(null);
                          skills.reload();
                        } catch (e) {
                          toast.error(message(e));
                        }
                      }}
                    >
                      {t("Delete")}
                    </Button>
                  </>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("Built-ins are read-only; upload a copy to change one.")}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="max-h-[70vh] overflow-y-auto">
              <Markdown text={skill.data.body} />
            </CardContent>
          </Card>
        ) : null}
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[92vh] sm:max-w-3xl">
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
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                ) : null}
                <input
                  type="file"
                  accept=".md,text/markdown"
                  className="text-sm"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      setEditing({
                        ...editing,
                        name: f.name.replace(/\.md$/, ""),
                        markdown: await f.text(),
                      });
                  }}
                />
                <Textarea
                  rows={18}
                  className="font-mono text-xs"
                  value={editing.markdown}
                  onChange={(e) => setEditing({ ...editing, markdown: e.target.value })}
                />
              </TabsContent>
              <TabsContent value="preview" className="max-h-[60vh] overflow-y-auto">
                <Markdown text={editing.markdown.replace(/^---[\s\S]*?---\n/, "")} />
              </TabsContent>
            </Tabs>
          ) : null}
          <DialogFooter>
            <Button onClick={save}>{t("Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
