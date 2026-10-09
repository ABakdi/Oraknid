import type {
  EvaluationKind,
  Evaluations,
  ProjectWorkSettings,
  TaskEvaluation,
} from "@oraknid/contracts";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

// Evaluation steps (ADR-064 §1): where I look at the work before what
// depends on it goes on. The project's settings, a job's own choice on
// New work, and a step as the job's page shows it.

const KINDS: { id: EvaluationKind; label: string; says: string }[] = [
  { id: "design", label: "Design", says: "the design, before feature code" },
  { id: "app", label: "Running app", says: "the finished app, before it's done" },
  { id: "checkpoint", label: "Checkpoints", says: "after a feature worth a look" },
];

const MODE_SAYS: Record<Evaluations["mode"], string> = {
  all: "The Eye puts a design review and a final review of the running app into every plan for work you'll see, and a checkpoint after a feature when it's worth one.",
  some: "Only the kinds ticked.",
  none: "No reviews: the jobs run to the end without waiting for you.",
};

/** All, some (which kinds) or none; with `project`, a fourth choice: the project's own. */
export function EvaluationsPicker({
  value,
  onChange,
  project,
  help,
}: {
  value: Evaluations | null;
  onChange: (v: Evaluations | null) => void;
  /** The project's setting, offered as the default (New work). */
  project?: Evaluations | null;
  help: string;
}) {
  const mode = value?.mode ?? "project";
  const kinds = value?.kinds ?? [];
  return (
    <div data-help={help} className="space-y-1.5">
      <Label>{t("Reviews")}</Label>
      <Select
        value={mode}
        onValueChange={(v) =>
          onChange(
            v === "project"
              ? null
              : {
                  mode: v as Evaluations["mode"],
                  kinds: v === "some" ? (kinds.length ? kinds : ["design", "app"]) : [],
                },
          )
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {project !== undefined ? (
            <SelectItem value="project">
              {t("The project's ({mode})", { mode: t(project?.mode ?? "all") })}
            </SelectItem>
          ) : null}
          <SelectItem value="all">{t("All")}</SelectItem>
          <SelectItem value="some">{t("Some")}</SelectItem>
          <SelectItem value="none">{t("None")}</SelectItem>
        </SelectContent>
      </Select>
      {value?.mode === "some" ? (
        <fieldset className="space-y-1">
          {KINDS.map((k) => (
            <label key={k.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kinds.includes(k.id)}
                onChange={(e) =>
                  onChange({
                    mode: "some",
                    kinds: e.target.checked
                      ? [...new Set([...kinds, k.id])]
                      : kinds.filter((x) => x !== k.id),
                  })
                }
              />
              <span>{t(k.label)}</span>
              <span className="text-xs text-muted-foreground">{t(k.says)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {value ? t(MODE_SAYS[value.mode]) : t("As the project's settings say.")}
      </p>
    </div>
  );
}

/** A project's reviews, how long one waits before it passes by itself, and merging at the end (ADR-064 §1, §8). */
export function ProjectWorkSettingsCard({ projectId }: { projectId: string }) {
  const live = useLive(() => api.projects.workSettings({ id: projectId }), {
    topics: ["overview"],
    deps: [projectId],
    refreshOn: (e) => e.type === "project.work-settings",
  });
  const [draft, setDraft] = useState<ProjectWorkSettings | null>(null);
  const [minutes, setMinutes] = useState("");
  useEffect(() => {
    if (!live.data) return;
    setDraft(live.data);
    setMinutes(live.data.autoPassMinutes ? String(live.data.autoPassMinutes) : "");
  }, [live.data]);
  if (!draft) return <Loading rows={2} />;
  const parsed = minutes.trim() ? Number(minutes) : null;
  const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0);
  const save = () =>
    api.projects
      .setWorkSettings({ id: projectId, settings: { ...draft, autoPassMinutes: parsed } })
      .then(() => toast.success(t("Saved: the next plans use it.")))
      .catch((e) => toast.error(message(e)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Reviews and the end of a job")}</CardTitle>
        <CardDescription>
          {t(
            "Reviews are steps in the plan where you look at the design or the running app, approve it or send notes that come back as work. A completed job is merged into the work branch, or you're asked first.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <EvaluationsPicker
          help="project.evaluations"
          value={draft.evaluations}
          onChange={(v) => setDraft({ ...draft, evaluations: v ?? { mode: "all", kinds: [] } })}
        />
        <div data-help="project.auto-pass" className="space-y-1.5">
          <Label htmlFor="p-pass">{t("A review passes by itself after (minutes)")}</Label>
          <Input
            id="p-pass"
            inputMode="decimal"
            placeholder={t("never: it waits for me")}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <p className="text-xs text-muted-foreground">
            {t("For jobs you don't watch. Empty: a review waits for you.")}
          </p>
        </div>
        <div data-help="project.merge" className="space-y-1.5">
          <Label>{t("When a job is done")}</Label>
          <Select
            value={draft.merge}
            onValueChange={(v) => setDraft({ ...draft, merge: v as ProjectWorkSettings["merge"] })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="merge">{t("Merge it into the work branch")}</SelectItem>
              <SelectItem value="ask">{t("Ask me first")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("A conflict, or changes of yours not committed, are asked about either way.")}
          </p>
        </div>
        <div className="flex items-end">
          <Button onClick={save} disabled={!valid}>
            {t("Save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** An evaluation step on the job's page: its kind, round, why, and the review to open. */
export function EvaluationNote({ evaluation }: { evaluation: TaskEvaluation }) {
  const kind = KINDS.find((k) => k.id === evaluation.kind);
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <p>
        <span className="font-medium">{t("Review: {kind}", { kind: t(kind?.label ?? "") })}</span>
        {" · "}
        {t("round {n}", { n: evaluation.round })}
        {evaluation.outcome ? ` · ${t(evaluation.outcome)}` : ""}
      </p>
      <p className="text-muted-foreground">{evaluation.why}</p>
      {evaluation.waiting && evaluation.url ? (
        <Button asChild size="sm">
          <a href={evaluation.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            {t("Open the review")}
          </a>
        </Button>
      ) : null}
      {evaluation.waiting && evaluation.passAt ? (
        <p className="text-xs text-muted-foreground">
          {t("Passes by itself at {at} if you say nothing.", {
            at: new Date(evaluation.passAt).toLocaleTimeString(),
          })}
        </p>
      ) : null}
    </div>
  );
}
