import type { Budget, JobInput } from "@oraknid/contracts";
import { Play, Send, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import {
  missing,
  NewProjectFields,
  newDraft,
  projectSource,
  rememberParent,
} from "@/components/new-project";
import { QuestionsForm } from "@/components/questions";
import { AddLegButtons, ToolsSetupButton } from "@/components/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

type Autonomy = "supervised" | "standard" | "full";

/**
 * The New work page (Jobs-and-Projects → Starting work): the options on the
 * left, my prompt and the conversation with The Eye on the right. The job
 * is a draft from my first word, saved as I go, started when I say so.
 */
export function WorkPage({ draftId }: { draftId?: string }) {
  const [, go] = useLocation();
  const projects = useLive(() => api.projects.list().then((l) => l.filter((p) => !p.archivedAt)), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("project."),
  });
  const skills = useLive(() => api.skills.list(), { topics: ["overview"] });
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const tools = useLive(() => api.tools.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("tool."),
  });
  const draftJob = useLive(
    () => (draftId ? api.jobs.get({ id: draftId }) : Promise.resolve(null)),
    {
      topics: draftId ? [`job:${draftId}`] : [],
      refreshOn: (e) => e.type === "job.state",
      deps: [draftId],
    },
  );

  // ── The options.
  // "New work" from a project's page arrives with that project chosen.
  // "New work on it" from Repos arrives with that repo to clone, through its account (ADR-040).
  const [arrived] = useState(() => {
    const st: unknown = history.state;
    const s = (st && typeof st === "object" ? st : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
    return { projectId: str("projectId"), repo: str("repo"), account: str("account") };
  });
  const [projectId, setProjectId] = useState<string>(arrived.repo ? "new" : arrived.projectId);
  const { confirm, dialog } = useConfirm();
  // A new project: the same form as New project's (M13.19).
  const [draft, setDraft] = useState(() =>
    newDraft(
      arrived.repo
        ? { origin: "github", via: "mine", repo: arrived.repo, repoAccount: arrived.account }
        : {},
    ),
  );
  const [skill, setSkill] = useState("auto");
  const [legIds, setLegIds] = useState<string[]>([]);
  const [autonomy, setAutonomy] = useState<Autonomy>("standard");
  const [tokensLimit, setTokensLimit] = useState("");
  const [money, setMoney] = useState<Budget["money"]>({ limit: 0, hard: true });
  const [share, setShare] = useState("");
  const [hours, setHours] = useState("8");
  const [verify, setVerify] = useState("");
  const [inputs, setInputs] = useState("");
  const [untrusted, setUntrusted] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  // A draft I come back to: its options as they were.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const j = draftJob.data;
    if (!j || loadedFor.current === j.id) return;
    loadedFor.current = j.id;
    setProjectId(j.projectId);
    setGoal(j.goal);
    // Its own skill, unless The Eye still chooses among the project's.
    setSkill(j.skillChoices.length > 1 ? "auto" : j.skillId);
    setAutonomy(j.autonomy);
    setLegIds(j.allowedLegIds);
    setTokensLimit(j.budget.tokens ? String(j.budget.tokens.limit) : "");
    setMoney(j.budget.money);
    setShare(j.budget.quotaShare ? String(Math.round(j.budget.quotaShare.limit * 100)) : "");
    setHours(j.budget.wallClockMs ? String(Math.round(j.budget.wallClockMs.limit / 3600_000)) : "");
    setInputs(j.inputs.map((i) => i.ref).join("\n"));
    setUntrusted(j.inputs.some((i) => i.untrusted));
  }, [draftJob.data]);

  const budget: Budget = useMemo(
    () => ({
      tokens: tokensLimit ? { limit: Number(tokensLimit), hard: true } : null,
      quotaShare: share ? { limit: Math.min(100, Number(share)) / 100, hard: true } : null,
      wallClockMs: hours ? { limit: Number(hours) * 3600_000, hard: false } : null,
      money,
    }),
    [tokensLimit, share, hours, money],
  );
  const jobInputs = useMemo(
    () =>
      inputs
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((ref) => ({
          kind: /^https?:/.test(ref) ? ("link" as const) : ("file" as const),
          ref,
          untrusted,
        })) as JobInput[],
    [inputs, untrusted],
  );
  const verifyLines = useMemo(
    () =>
      verify
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    [verify],
  );

  // A draft is saved as I go (New work → The draft).
  useEffect(() => {
    if (!draftId || loadedFor.current !== draftId || draftJob.data?.state !== "draft") return;
    const timer = setTimeout(() => {
      api.jobs
        .updateDraft({
          id: draftId,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          autonomy,
          allowedLegIds: legIds,
          budget,
          verify: verifyLines,
          inputs: jobInputs,
          ...(skill !== "auto" ? { skillId: skill } : {}),
        })
        .catch((e) => toast.error(message(e)));
    }, 600);
    return () => clearTimeout(timer);
  }, [
    draftId,
    draftJob.data?.state,
    goal,
    autonomy,
    legIds,
    budget,
    verifyLines,
    jobInputs,
    skill,
  ]);

  const projectList = projects.data ?? [];
  const chosenProject = projectList.find((p) => p.id === projectId);
  const isNew = !draftId && projectId === "new";
  const effectiveProject = draftId ? draftJob.data?.projectId : projectId || projectList[0]?.id;
  const shownProject = projectList.find((p) => p.id === effectiveProject);

  // The project's budget is where a new job's starts (ADR-034).
  useEffect(() => {
    if (draftId || !effectiveProject || effectiveProject === "new") return;
    let cancelled = false;
    api.projects
      .budget({ id: effectiveProject })
      .then((v) => {
        if (cancelled) return;
        setTokensLimit(v.budget.tokens ? String(v.budget.tokens.limit) : "");
        setMoney(v.budget.money ?? { limit: 0, hard: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveProject, draftId]);

  // Tools the skill needs (ADR-021): missing ones hold the start.
  const skillIds =
    skill !== "auto"
      ? [skill]
      : shownProject?.skillIds.length
        ? shownProject.skillIds
        : (skills.data ?? []).slice(0, 1).map((s) => s.id);
  const needed = [
    ...new Set(
      (skills.data ?? []).filter((s) => skillIds.includes(s.id)).flatMap((s) => s.requiredTools),
    ),
  ];
  const ready = new Set(
    (tools.data ?? []).filter((x) => !x.missingSecrets.length).map((x) => x.name),
  );
  const missingTools = needed.filter((n) => !ready.has(n));

  const healthy = (legs.data ?? []).filter((l) => l.health === "healthy" && !l.paused);
  const sourceReady = !isNew || !missing(draft);
  const why =
    !effectiveProject && !isNew
      ? t("Choose a project.")
      : !sourceReady
        ? missing(draft)
        : !goal.trim()
          ? t("Write what you want done.")
          : healthy.length === 0
            ? t("No Leg is healthy right now.")
            : missingTools.length
              ? t("Set up {tools} first.", { tools: missingTools.join(", ") })
              : null;
  // What holds the start and can be set up right here.
  const fixes =
    healthy.length === 0 || missingTools.length ? (
      <div className="flex flex-wrap items-center gap-2">
        {healthy.length === 0 ? <AddLegButtons size="sm" /> : null}
        {missingTools.length ? <ToolsSetupButton missing={missingTools} /> : null}
      </div>
    ) : null;

  /** The project, made now when it is a new one. */
  const projectForJob = async (): Promise<string> => {
    if (!isNew) return effectiveProject as string;
    // A folder I have that isn't a repo becomes one here (the dialog asks instead).
    const src = projectSource(draft, { initGit: true });
    if (!src) throw new Error(missing(draft) ?? t("Say where the new project goes."));
    if (draft.origin !== "folder") rememberParent(draft.parent);
    const p = await api.projects.createFrom({
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      source: src,
    });
    setProjectId(p.id);
    return p.id;
  };

  /** From my first prompt: the project if new, the draft, and The Eye's first word. */
  const begin = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const pid = await projectForJob();
      const { id } = await api.jobs.create({
        projectId: pid,
        goal: goal.trim(),
        ...(skill !== "auto" ? { skillId: skill } : {}),
        autonomy,
        allowedLegIds: legIds,
        verify: verifyLines,
        inputs: jobInputs,
        unsandboxed: false,
        budget,
      });
      await api.jobs.draftStart({ id });
      go(`/new/${id}`, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.jobs.updateDraft({
        id: draftId,
        goal: goal.trim(),
        autonomy,
        allowedLegIds: legIds,
        budget,
        verify: verifyLines,
        inputs: jobInputs,
        ...(skill !== "auto" ? { skillId: skill } : {}),
      });
      await api.jobs.start({ id: draftId });
      // Started, it is followed in its project's Eye tab (ADR-034).
      go(`/projects/${draftJob.data?.projectId ?? effectiveProject}/eye`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draftId) return;
    if (
      !(await confirm(
        t("Delete this draft?"),
        t("Its goal, options and conversation with The Eye are gone for good."),
        t("Delete"),
        { keep: t("Keep it") },
      ))
    )
      return;
    await api.jobs
      .remove({ id: draftId })
      .then(() => {
        toast.success(t("Draft deleted."));
        go("/new", { replace: true });
      })
      .catch((e) => toast.error(message(e)));
  };

  if (projects.loading || (draftId && draftJob.loading)) return <Loading />;
  if (draftId && draftJob.data && draftJob.data.state !== "draft")
    return (
      <div className="mx-auto max-w-xl space-y-3 text-sm">
        <PageHeader title={t("New work")} back={{ fallback: "/new" }} />
        <div>
          {t("This job has started.")}{" "}
          <Link
            href={`/projects/${draftJob.data.projectId}/eye`}
            className="underline underline-offset-2"
          >
            {t("Follow it in its project")}
          </Link>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={draftId ? t("Draft") : t("New work")}
        back={draftId ? { fallback: "/new" } : undefined}
        sub={
          draftId
            ? t("Saved as you go: leave and come back from New work, start it, or delete it.")
            : t(
                "A first request, a new project or a draft. For more work in a project, ask in its Eye tab.",
              )
        }
      />
      {draftId ? null : <Drafts />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* ── Left: the options. */}
        <Card className="h-fit min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">{t("Options")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div data-help="work.project" className="space-y-1.5">
              <Label>{t("Project")}</Label>
              {draftId ? (
                <div className="font-medium">{shownProject?.name ?? "…"}</div>
              ) : (
                <Select
                  value={projectId || projectList[0]?.id || "new"}
                  onValueChange={setProjectId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projectList.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="new">{t("A new project…")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {chosenProject ? (
                <div className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {chosenProject.workspacePath}
                </div>
              ) : null}
            </div>
            {isNew ? (
              <div className="rounded-md border p-3">
                <NewProjectFields draft={draft} onChange={setDraft} plainFolder="init" />
              </div>
            ) : null}

            <div data-help="work.skill" className="space-y-1.5">
              <Label>{t("Method (skill)")}</Label>
              <Select value={skill} onValueChange={setSkill}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("The project's skills (The Eye picks)")}</SelectItem>
                  {(skills.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {needed.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{t("Uses:")}</span>
                  {needed.map((n) => (
                    <Badge key={n} variant={ready.has(n) ? "outline" : "destructive"}>
                      {ready.has(n) ? n : t("{tool} (not set up)", { tool: n })}
                    </Badge>
                  ))}
                  {missingTools.length ? <ToolsSetupButton missing={missingTools} /> : null}
                </div>
              ) : null}
              <SkillUpload
                onAdded={(id) => {
                  skills.reload();
                  setSkill(id);
                }}
              />
            </div>

            <fieldset data-help="work.legs" className="min-w-0 space-y-1">
              <legend className="font-medium">{t("Legs")}</legend>
              <div className="text-xs text-muted-foreground">
                {t("None ticked: any healthy Leg.")}
              </div>
              {(legs.data ?? []).length === 0 ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <AddLegButtons size="sm" />
                </div>
              ) : null}
              {(legs.data ?? []).map((l) => (
                <label key={l.id} className="flex min-h-9 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={legIds.includes(l.id)}
                    onChange={(e) =>
                      setLegIds(
                        e.target.checked ? [...legIds, l.id] : legIds.filter((x) => x !== l.id),
                      )
                    }
                  />
                  <span className="min-w-0 truncate" title={l.name}>
                    {l.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">({t(l.health)})</span>
                </label>
              ))}
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <div data-help="work.autonomy" className="col-span-2 space-y-1.5">
                <Label>{t("Autonomy")}</Label>
                <Select value={autonomy} onValueChange={(v) => setAutonomy(v as Autonomy)}>
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
              <div data-help="work.tokens" className="space-y-1.5">
                <Label htmlFor="w-tok">{t("Token limit")}</Label>
                <Input
                  id="w-tok"
                  inputMode="numeric"
                  placeholder={t("none")}
                  value={tokensLimit}
                  onChange={(e) => setTokensLimit(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              <div data-help="work.alarm" className="space-y-1.5">
                <Label htmlFor="w-hours">{t("Alarm (hours)")}</Label>
                <Input
                  id="w-hours"
                  inputMode="numeric"
                  value={hours}
                  onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              <div data-help="work.quota-share" className="col-span-2 space-y-1.5">
                <Label htmlFor="w-share">{t("Most of a Leg's quota window to use (%)")}</Label>
                <Input
                  id="w-share"
                  inputMode="numeric"
                  placeholder="100"
                  value={share}
                  onChange={(e) => setShare(e.target.value.replace(/\D/g, "").slice(0, 3))}
                />
              </div>
            </div>

            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("Checks and inputs")}
              </summary>
              <div className="mt-2 space-y-3">
                <div data-help="work.checks" className="space-y-1.5">
                  <Label htmlFor="w-verify">{t("Job-level checks (one per line)")}</Label>
                  <Textarea
                    id="w-verify"
                    rows={2}
                    className="font-mono text-xs"
                    value={verify}
                    onChange={(e) => setVerify(e.target.value)}
                    placeholder="pnpm test"
                  />
                </div>
                <div data-help="work.inputs" className="space-y-1.5">
                  <Label htmlFor="w-inputs">{t("Inputs (files in the project, or links)")}</Label>
                  <Textarea
                    id="w-inputs"
                    rows={2}
                    className="font-mono text-xs"
                    value={inputs}
                    onChange={(e) => setInputs(e.target.value)}
                  />
                  <label htmlFor="w-untrusted" className="flex items-center gap-2 text-xs">
                    <Switch id="w-untrusted" checked={untrusted} onCheckedChange={setUntrusted} />
                    {t("From outside my control (untrusted data)")}
                  </label>
                </div>
              </div>
            </details>
          </CardContent>
        </Card>

        {/* ── Right: the prompt and the conversation. */}
        <Card className="flex min-h-[60vh] min-w-0 flex-col">
          {draftId ? (
            <Conversation
              jobId={draftId}
              goal={goal}
              onGoal={setGoal}
              footer={
                <div className="flex flex-wrap items-center gap-2">
                  <ErrorNote error={error} />
                  {fixes}
                  <span className="flex-1" />
                  <Button variant="ghost" className="gap-1 text-destructive" onClick={remove}>
                    <Trash2 className="size-4" />
                    {t("Delete")}
                  </Button>
                  <Button
                    data-help="work.start"
                    className="gap-1"
                    disabled={!!why || busy}
                    onClick={start}
                  >
                    <Play className="size-4" />
                    {busy ? t("Starting…") : (why ?? t("Start"))}
                  </Button>
                </div>
              }
            />
          ) : (
            <CardContent className="flex flex-1 flex-col gap-3 pt-6">
              <Label htmlFor="w-goal" className="text-base">
                {t("What do you want done?")}
              </Label>
              <Textarea
                id="w-goal"
                data-help="work.goal"
                className="min-h-48 flex-1"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t("Describe it in your words: the goal, what matters, what to avoid.")}
              />
              <ErrorNote error={error} />
              <div className="flex flex-wrap items-center justify-end gap-2">
                {fixes}
                <Button data-help="work.continue" disabled={!!why || busy} onClick={begin}>
                  {busy ? t("Saving…") : (why ?? t("Continue"))}
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
      {dialog}
    </div>
  );
}

/** Drafts waiting to start (Jobs-and-Projects → The draft): they live here now. */
function Drafts() {
  const jobs = useLive(() => api.jobs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  const projects = useLive(() => api.projects.list(), { topics: ["overview"] });
  const drafts = (jobs.data ?? []).filter((j) => j.state === "draft").reverse();
  if (!drafts.length) return null;
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return (
    <section data-help="work.drafts" aria-label={t("Drafts")} className="space-y-1.5">
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("Drafts")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {drafts.map((d) => (
          <Link
            key={d.id}
            href={`/new/${d.id}`}
            className="flex min-h-9 max-w-full items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-accent pointer-coarse:min-h-11"
          >
            <span className="min-w-0 truncate" title={d.title}>
              {d.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {names.get(d.projectId) ?? ""}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** A skill added from a .md file, here where the method is chosen. */
function SkillUpload({ onAdded }: { onAdded: (id: string) => void }) {
  return (
    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
      <label className="cursor-pointer">
        <Upload className="size-3.5" />
        {t("Add a skill from a .md file")}
        <input
          type="file"
          accept=".md,.markdown,text/markdown"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const up = await api.skills.upload({
                name: f.name.replace(/\.(md|markdown)$/i, ""),
                markdown: await f.text(),
              });
              if (up.ignored.length) toast.warning(up.ignored.join(" "));
              toast.success(t("Added {name}; this job uses it.", { name: up.skill.name }));
              onAdded(up.skill.id);
            } catch (x) {
              toast.error(message(x));
            }
          }}
        />
      </label>
    </Button>
  );
}

/** The draft's conversation with The Eye: the interview, or context. */
function Conversation({
  jobId,
  goal,
  onGoal,
  footer,
}: {
  jobId: string;
  goal: string;
  onGoal: (g: string) => void;
  footer: React.ReactNode;
}) {
  const talk = useLive(() => api.jobs.conversation({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "eye.message" || e.type === "eye.replied",
    deps: [jobId],
  });
  const thinking = useLive(() => api.jobs.draftThinking({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "eye.message" || e.type === "eye.replied",
    deps: [jobId],
  });
  const [text, setText] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = talk.data?.length ?? 0;
  const replied = new Set((talk.data ?? []).map((m) => m.replyTo).filter(Boolean));
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the conversation grows
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [count, thinking.data]);
  const send = async () => {
    const t0 = text.trim();
    if (!t0) return;
    setText("");
    try {
      await api.jobs.draftTalk({ id: jobId, text: t0 });
      thinking.reload();
    } catch (e) {
      setText(t0);
      toast.error(message(e));
    }
  };
  return (
    <>
      <div className="space-y-1 border-b px-4 py-3">
        <div className="text-xs font-medium text-muted-foreground">{t("What I want")}</div>
        {editingGoal ? (
          <Textarea
            rows={3}
            value={goal}
            autoFocus
            onChange={(e) => onGoal(e.target.value)}
            onBlur={() => setEditingGoal(false)}
          />
        ) : (
          <button
            type="button"
            className="block w-full text-left text-sm whitespace-pre-wrap [overflow-wrap:anywhere] hover:bg-accent/50"
            onClick={() => setEditingGoal(true)}
            title={t("Edit")}
          >
            {goal}
          </button>
        )}
      </div>
      <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {(talk.data ?? []).map((m) => (
          <div key={m.id} className="space-y-1.5">
            <div className={cn("flex", m.author === "owner" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm md:max-w-[80%]",
                  m.author === "owner" ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {m.author === "owner" && !m.answers ? (
                  <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</div>
                ) : (
                  <Markdown text={m.text} />
                )}
              </div>
            </div>
            {/* The round's questions, asked with options until I answer them (ADR-037). */}
            {m.questions?.length && !replied.has(m.id) ? (
              <QuestionsForm
                questions={m.questions}
                busy={!!thinking.data}
                onSubmit={async (answers) => {
                  try {
                    await api.jobs.draftAnswer({ id: jobId, messageId: m.id, answers });
                    thinking.reload();
                  } catch (e) {
                    toast.error(message(e));
                  }
                }}
              />
            ) : null}
          </div>
        ))}
        {thinking.data ? (
          <div className="text-xs text-muted-foreground">{t("The Eye is thinking…")}</div>
        ) : null}
      </div>
      <form
        className="flex items-end gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          rows={2}
          value={text}
          placeholder={t("Answer, or add context… (Enter sends, Shift+Enter for a new line)")}
          className="min-h-11 flex-1 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" aria-label={t("Send")} disabled={!text.trim() || !!thinking.data}>
          <Send className="size-4" />
        </Button>
      </form>
      <div className="border-t px-3 py-2">{footer}</div>
    </>
  );
}
