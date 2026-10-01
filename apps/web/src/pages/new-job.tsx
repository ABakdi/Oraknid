import { useState } from "react";
import { useLocation } from "wouter";
import { ErrorNote, Markdown, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** One form, everything on it (Jobs-and-Projects → Creating a job). */
export function NewJobPage() {
  const [, go] = useLocation();
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "project.created",
  });
  const skills = useLive(() => api.skills.list(), { topics: [] });
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const [projectId, setProjectId] = useState<string>("");
  const [goal, setGoal] = useState("");
  const [skillId, setSkillId] = useState<string>("");
  const [autonomy, setAutonomy] = useState<"supervised" | "standard" | "full">("standard");
  const [legIds, setLegIds] = useState<string[]>([]);
  const [tokensLimit, setTokensLimit] = useState("");
  const [hours, setHours] = useState("8");
  const [verify, setVerify] = useState("");
  const [inputs, setInputs] = useState("");
  const [untrusted, setUntrusted] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const project = projectId || projects.data?.[0]?.id || "";
  const skill = skillId || skills.data?.[0]?.id || "";
  const healthy = (legs.data ?? []).filter((l) => l.health === "healthy" && !l.paused);
  const why = !project
    ? t("Create a project first.")
    : !goal.trim()
      ? t("Write the goal.")
      : healthy.length === 0
        ? t("No Leg is healthy right now.")
        : null;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api.jobs.create({
        projectId: project,
        goal: goal.trim(),
        skillId: skill,
        autonomy,
        allowedLegIds: legIds,
        verify: verify
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        inputs: inputs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((ref) => ({
            kind: /^https?:/.test(ref) ? "link" : ("file" as const),
            ref,
            untrusted,
          })) as never,
        unsandboxed: false,
        budget: {
          tokens: tokensLimit ? { limit: Number(tokensLimit), hard: true } : null,
          quotaShare: null,
          wallClockMs: hours ? { limit: Number(hours) * 3600_000, hard: false } : null,
          money: { limit: 0, hard: true },
        },
      });
      await api.jobs.start({ id });
      go(`/jobs/${id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const chosenSkill = skills.data?.find((s) => s.id === skill);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("New job")} />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1.5">
            <Label>{t("Project")}</Label>
            {(projects.data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("No project yet.")}{" "}
                <Button variant="link" className="h-auto p-0" onClick={() => go("/projects")}>
                  {t("Create one")}
                </Button>
              </div>
            ) : (
              <Select value={project} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {p.workspacePath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal">{t("Goal")}</Label>
            <Textarea
              id="goal"
              rows={5}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t("What should be true when this job is done, in your words.")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("Method (skill)")}</Label>
            <Select value={skill} onValueChange={setSkillId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(skills.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} {s.source === "built-in" ? `(${t("built-in")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosenSkill ? (
              <Markdown
                className="text-muted-foreground"
                text={`${chosenSkill.description}${chosenSkill.interview ? `\n\n${t("It starts by interviewing you in the inbox.")}` : ""}`}
              />
            ) : null}
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("Legs")}</legend>
            <div className="text-xs text-muted-foreground">
              {t("None ticked: any healthy Leg.")}
            </div>
            {(legs.data ?? []).map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={legIds.includes(l.id)}
                  onChange={(e) =>
                    setLegIds(
                      e.target.checked ? [...legIds, l.id] : legIds.filter((x) => x !== l.id),
                    )
                  }
                />
                {l.name}
                <span className="text-xs text-muted-foreground">({l.health})</span>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t("Autonomy")}</Label>
              <Select value={autonomy} onValueChange={(v) => setAutonomy(v as typeof autonomy)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supervised">{t("Supervised")}</SelectItem>
                  <SelectItem value="standard">{t("Standard")}</SelectItem>
                  <SelectItem value="full">{t("Full")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tok">{t("Token limit")}</Label>
              <Input
                id="tok"
                inputMode="numeric"
                placeholder={t("none")}
                value={tokensLimit}
                onChange={(e) => setTokensLimit(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hours">{t("Come-and-look alarm (hours)")}</Label>
              <Input
                id="hours"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="verify">{t("Job-level checks (one per line, optional)")}</Label>
            <Textarea
              id="verify"
              rows={2}
              className="font-mono text-xs"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
              placeholder="pnpm test"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inputs">
              {t("Inputs (files in the project, or links; one per line)")}
            </Label>
            <Textarea
              id="inputs"
              rows={2}
              className="font-mono text-xs"
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
            <label htmlFor="untrusted" className="flex items-center gap-2 text-sm">
              <Switch id="untrusted" checked={untrusted} onCheckedChange={setUntrusted} />
              {t("These inputs come from outside my control (treat as untrusted data)")}
            </label>
          </div>
          <ErrorNote error={error} />
          <Button className="w-full" disabled={!!why || busy} onClick={start}>
            {busy ? t("Starting…") : (why ?? t("Start"))}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
