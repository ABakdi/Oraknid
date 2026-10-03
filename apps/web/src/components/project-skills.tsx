import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Loading } from "@/components/common";
import { ToolsSetupButton } from "@/components/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * A project's skills (Skills → Skills per project): The Eye picks the one
 * that fits each job among them. A skill can be added from a .md file here.
 */
export function ProjectSkillsCard({ projectId }: { projectId: string }) {
  const skills = useLive(() => api.skills.list(), { topics: ["overview"] });
  const tools = useLive(() => api.tools.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("tool."),
  });
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "project.skills",
  });
  if (!skills.data || !projects.data) return <Loading rows={2} />;
  const ready = new Set(
    (tools.data ?? []).filter((x) => !x.missingSecrets.length).map((x) => x.name),
  );
  const project = projects.data.find((p) => p.id === projectId);
  if (!project) return null;
  const set = project.skillIds;
  const save = (ids: string[]) =>
    api.projects
      .setSkills({ id: projectId, skillIds: ids })
      .then(projects.reload)
      .catch((e) => toast.error(message(e)));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("Skills for this project")}</CardTitle>
        <CardDescription>
          {set.length > 1
            ? t(
                "The Eye picks the one that fits each job, and may use the others' guidance for a task.",
              )
            : t(
                "Tick more than one and The Eye picks the one that fits each job. None ticked: the default skill.",
              )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {skills.data.map((s) => {
          const missing = s.requiredTools.filter((x) => !ready.has(x));
          return (
            <div key={s.id} className="flex flex-wrap items-start gap-2">
              <label className="flex min-w-0 flex-1 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={set.includes(s.id)}
                  onChange={(e) =>
                    save(e.target.checked ? [...set, s.id] : set.filter((x) => x !== s.id))
                  }
                />
                <span className="min-w-0">
                  <span className="font-medium">{s.name}</span>{" "}
                  {s.source === "built-in" ? (
                    <Badge variant="outline">{t("built-in")}</Badge>
                  ) : null}
                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {s.description}
                  </span>
                </span>
              </label>
              <Link
                href={`/skills/${s.id}`}
                className="pt-0.5 text-xs text-muted-foreground underline underline-offset-2"
              >
                {t("Read")}
              </Link>
              {missing.length ? <ToolsSetupButton missing={missing} /> : null}
            </div>
          );
        })}
        <Button asChild variant="secondary" size="sm" className="gap-1">
          <label className="cursor-pointer">
            <Upload className="size-3.5" />
            {t("Add a skill from a .md file")}
            <input
              type="file"
              accept=".md,.markdown,text/markdown"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const up = await api.skills.upload({
                    name: f.name.replace(/\.(md|markdown)$/i, ""),
                    markdown: await f.text(),
                  });
                  await save([...set, up.skill.id]);
                  toast.success(t("Added {name} to this project.", { name: up.skill.name }));
                  skills.reload();
                } catch (x) {
                  toast.error(message(x));
                }
              }}
            />
          </label>
        </Button>
      </CardContent>
    </Card>
  );
}
