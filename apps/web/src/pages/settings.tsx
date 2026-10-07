import type { EyeModels, NotificationSettings, NotifyEvent, Route } from "@oraknid/contracts";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { AwayCard, PhoneCard } from "@/components/away-card";
import { BackupsSettings } from "@/components/backups";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { GitHubCard } from "@/components/github-card";
import { LockCard } from "@/components/lock-card";
import { MailAccountsCard } from "@/components/mail-accounts-card";
import { MovingCard } from "@/components/moving";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { RulesCard } from "@/components/rules-card";
import { StorageCard } from "@/components/storage-card";
import { TerminalCard } from "@/components/terminal-card";
import { ToolsCard } from "@/components/tools-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UpdatesCard } from "@/components/updates";
import { api, auth, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cameFromPage } from "@/lib/nav";
import { remote } from "@/lib/remote";
import { type ThemeChoice, useTheme } from "@/lib/theme";

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(message(e));
  }
}

/**
 * Settings in tabs, each one concern (Web-UI → Settings): the tab is in
 * the address (/settings/<tab>), so a link can open the right one.
 */
const TABS = [
  { id: "general", label: "General" },
  { id: "work", label: "Eye & jobs" },
  { id: "security", label: "Security" },
  { id: "devices", label: "Devices & phone" },
  { id: "connections", label: "Connections" },
  { id: "backups", label: "Backups" },
  { id: "about", label: "About & updates" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function SettingsPage({ tab }: { tab?: string }) {
  // Opened from another page (a "Settings" link next to a control): a way back to it.
  const [from] = useState(cameFromPage);
  const wrap = (node: React.ReactNode) => (
    <div className="mx-auto max-w-3xl space-y-6 pt-1">{node}</div>
  );
  const content: Record<TabId, () => React.ReactNode> = {
    general: () =>
      wrap(
        <>
          <Section help="settings.computer" title={t("This computer")}>
            <SystemCard />
            <StorageCard />
          </Section>
          <Section help="settings.notifications" title={t("Notifications")}>
            <NotificationsCard />
          </Section>
          <Section help="settings.theme" title={t("Look")}>
            <ThemeCard />
          </Section>
        </>,
      ),
    work: () =>
      wrap(
        <>
          <Section help="settings.eye" title={t("The Eye")}>
            <EyeCard />
          </Section>
          <Section help="settings.jobs" title={t("Running jobs")}>
            <JobsLimitCard />
            <WorkAtOnceCard />
            <FallbackCard />
          </Section>
        </>,
      ),
    security: () =>
      wrap(
        <>
          <Section help="settings.lock" title={t("Unlocking")}>
            <LockCard />
          </Section>
          <Section help="settings.rules" title={t("What agents may run")}>
            <PolicyCard />
          </Section>
          <Section help="settings.terminal" title={t("Terminal")}>
            <TerminalCard />
          </Section>
        </>,
      ),
    devices: () =>
      wrap(
        <>
          <Section help="settings.phone" title={t("Your phone, from anywhere")}>
            <PhoneCard />
          </Section>
          <Section help="settings.devices" title={t("Paired devices")}>
            <DevicesCard />
          </Section>
          <Section help="settings.nest" title={t("The Nest")}>
            <AwayCard />
          </Section>
        </>,
      ),
    connections: () =>
      wrap(
        <>
          <Section help="settings.mail" title={t("Email accounts")}>
            <MailAccountsCard />
          </Section>
          <Section help="settings.github" title={t("GitHub")}>
            <GitHubCard />
          </Section>
          <Section help="settings.tools" title={t("Tools for skills")}>
            <ToolsCard />
          </Section>
        </>,
      ),
    // Database backups on my servers (ADR-044).
    backups: () => wrap(<BackupsSettings />),
    // Oraknid's version, its channel, and its updates (ADR-048).
    about: () =>
      wrap(
        <>
          <Section help="settings.updates" title={t("Version and updates")}>
            <UpdatesCard />
          </Section>
          <Section title={t("Moving")}>
            <MovingCard />
          </Section>
        </>,
      ),
  };
  const tabs: PageTab[] = TABS.map((x) => ({
    id: x.id,
    label: t(x.label),
    content: content[x.id],
  }));
  return (
    <PageTabs
      base="/settings"
      tab={TABS.some((x) => x.id === tab) ? tab : "general"}
      tabs={tabs}
      header={
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader title={t("Settings")} back={from ? { fallback: "/" } : undefined} />
        </div>
      }
    />
  );
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  /** Its id in the help map (ADR-041). */
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-help={help}>
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SystemCard() {
  const s = useLive(() => api.system.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "system.inhibitor",
  });
  const [pass, setPass] = useState("");
  if (!s.data) return <Loading rows={2} />;
  const d = s.data;
  const row = (label: string, ok: boolean, detail: string) => (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-warning"}`} />
      <span className="w-24 shrink-0 font-medium sm:w-36">{label}</span>
      <span className="text-muted-foreground [overflow-wrap:anywhere]">{detail}</span>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("This machine")}</CardTitle>
        <CardDescription>
          Oraknid {d.version} · {t("up {when}", { when: ago(d.startedAt).replace(" ago", "") })} ·{" "}
          {d.dataDir}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {row(
          t("Sleep"),
          true,
          d.inhibitor.held
            ? t("Kept awake: {why}", { why: d.inhibitor.why ?? "" })
            : t("Not held; no job is active."),
        )}
        {d.inhibitor.problem ? row(t("Sleep problem"), false, d.inhibitor.problem) : null}
        {row(t("Sandbox"), d.sandbox.available, d.sandbox.detail)}
        {row(t("Secrets"), d.secrets.available, d.secrets.detail)}
        {row(
          t("Service"),
          !d.service.fix,
          d.service.fix ? `${d.service.detail} ${d.service.fix}` : d.service.detail,
        )}
        {!d.secrets.available ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Input
              type="password"
              className="w-full sm:w-64"
              aria-label={t("Passphrase for the secrets file")}
              placeholder={t("Passphrase for the secrets file")}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            <Button
              onClick={() =>
                act(
                  () => api.secrets.unlock({ passphrase: pass }).then(() => s.reload()),
                  t("Unlocked."),
                )
              }
            >
              {t("Unlock")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const EYE_ROWS: [keyof EyeModels, string, string][] = [
  ["leg", "The Eye's Leg", "Every decision, unless one below is set."],
  ["planning", "Planning", "Plans, replans and interviews."],
  ["judging", "Judging", "Reviews of work without checks, and repairs of wrong checks."],
  ["quick", "Quick calls", "Command checks, your messages to The Eye, summaries."],
  [
    "shadow",
    "Shadow planner",
    "Also plans every job, in the background, never used: to compare it with the plan that runs. A free model costs nothing.",
  ],
];

function EyeCard() {
  const legs = useLive(() => api.legs.list(), { topics: ["overview"] });
  const saved = useLive(() => api.settings.eyeModels(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const [draft, setDraft] = useState<EyeModels | null>(null);
  if (!saved.data) return <Loading rows={2} />;
  const value = draft ?? saved.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("The Eye")}</CardTitle>
        <CardDescription>
          {t(
            "The models The Eye borrows to decide. Unset, routing picks the strongest available; a model that isn't available falls back the same way.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {EYE_ROWS.map(([key, label, hint]) => (
          <div key={key} className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center">
            <Label htmlFor={`eye-${key}`}>{t(label)}</Label>
            <div className="min-w-0 space-y-1">
              <Select
                value={value[key] ?? "auto"}
                onValueChange={(v) => setDraft({ ...value, [key]: v === "auto" ? null : v })}
              >
                <SelectTrigger id={`eye-${key}`} className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {key === "shadow" ? t("None") : t("Let routing choose")}
                  </SelectItem>
                  {(legs.data ?? []).flatMap((l) =>
                    l.models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {l.name} · {m.model}
                      </SelectItem>
                    )),
                  )}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">{t(hint)}</div>
            </div>
          </div>
        ))}
        <Button
          disabled={!draft}
          onClick={() =>
            act(async () => {
              await api.settings.setEyeModels(value);
              setDraft(null);
            }, t("Saved."))
          }
        >
          {t("Save")}
        </Button>
        <InterviewRounds />
      </CardContent>
    </Card>
  );
}

/** How many rounds The Eye's interview may take before it plans with what it knows. */
function InterviewRounds() {
  const rounds = useLive(() => api.settings.interviewRounds(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  return (
    <div className="grid gap-1.5 border-t pt-3 sm:grid-cols-[10rem_1fr] sm:items-center">
      <Label htmlFor="eye-interview-rounds">{t("Interview")}</Label>
      <div className="min-w-0 space-y-1">
        <Select
          value={String(rounds.data ?? 3)}
          onValueChange={(v) =>
            act(() => api.settings.setInterviewRounds({ rounds: Number(v) }), t("Saved."))
          }
        >
          <SelectTrigger id="eye-interview-rounds" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 1
                  ? t("At most 1 round of questions")
                  : t("At most {n} rounds of questions", { n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground">
          {t(
            "Only what blocks planning is asked, never twice; the rest The Eye decides and says so in its playback. Say “enough, start” any time to end it.",
          )}
        </div>
      </div>
    </div>
  );
}

const EVENTS: [NotifyEvent, string][] = [
  ["approval", "Approval needed"],
  ["question", "A question or interview round"],
  ["escalation", "A task keeps going wrong"],
  ["job.completed", "Job completed"],
  ["job.blocked", "Job blocked"],
  ["budget", "Budget warnings"],
  ["time.alarm", "Time alarm"],
  ["recovered", "Recovered after a stop"],
  ["leg.unavailable", "A Leg became unavailable"],
  ["security", "Wrong PINs, a device unpaired"],
  ["backup.failed", "A backup failed"],
  ["update.available", "A new version of Oraknid"],
  ["machine.danger", "The computer in danger"],
  ["job.resumed", "A job paused for quota resumed by itself"],
  ["sleep.problem", "The computer can't be kept awake"],
  ["site.down", "A site is down"],
  ["site.up", "A site is up again"],
];
const DEFAULTS: Record<NotifyEvent, Route> = {
  approval: { desktop: true, push: true, email: "after-15-min" },
  question: { desktop: true, push: true, email: "after-15-min" },
  "job.completed": { desktop: true, push: true, email: "now" },
  "job.blocked": { desktop: true, push: true, email: "now" },
  escalation: { desktop: true, push: true, email: "now" },
  budget: { desktop: true, push: true, email: "never" },
  "time.alarm": { desktop: true, push: true, email: "now" },
  recovered: { desktop: true, push: true, email: "never" },
  "leg.unavailable": { desktop: false, push: false, email: "never" },
  security: { desktop: true, push: true, email: "now" },
  "backup.failed": { desktop: true, push: true, email: "now" },
  "update.available": { desktop: true, push: true, email: "never" },
  "machine.danger": { desktop: true, push: true, email: "never" },
  "job.resumed": { desktop: true, push: true, email: "never" },
  "sleep.problem": { desktop: true, push: true, email: "never" },
  "site.down": { desktop: true, push: true, email: "now" },
  "site.up": { desktop: true, push: true, email: "never" },
};

function NotificationsCard() {
  const n = useLive(() => api.notifications.get(), { topics: [] });
  const [smtp, setSmtp] = useState({
    host: "",
    port: "465",
    user: "",
    from: "",
    to: "",
    password: "",
  });
  if (!n.data) return <Loading rows={3} />;
  const s = n.data;
  const update = (patch: Parameters<typeof api.notifications.update>[0]) =>
    act(() => api.notifications.update(patch).then(() => n.reload()));
  const route = (e: NotifyEvent): Route => s.routes[e] ?? DEFAULTS[e];
  const setRoute = (e: NotifyEvent, r: Route) =>
    update({ routes: { ...s.routes, [e]: r } as NotificationSettings["routes"] });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Notifications")}</CardTitle>
        <CardDescription>{t("Few, and each worth interrupting you for.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4">
          {(["desktop", "push", "email"] as const).map((c) => (
            <label key={c} htmlFor={`channel-${c}`} className="flex items-center gap-2 text-sm">
              <Switch
                id={`channel-${c}`}
                checked={s[c].enabled}
                onCheckedChange={(v) => update({ [c]: v })}
              />
              {t(
                c === "push"
                  ? "Push (this and other devices)"
                  : c === "desktop"
                    ? "Desktop"
                    : "Email",
              )}
            </label>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              act(async () => {
                const r = await api.notifications.test({});
                toast.message(
                  r
                    .map(
                      (x) =>
                        `${x.channel}: ${x.enabled ? (x.delivered ? "sent" : x.problems.join(" ")) : "off"}`,
                    )
                    .join(" · "),
                );
              })
            }
          >
            {t("Send a test")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => act(subscribePush, t("This device gets push notifications."))}
          >
            {t("Push to this device")}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("When")}</TableHead>
                <TableHead>{t("Desktop")}</TableHead>
                <TableHead>{t("Push")}</TableHead>
                <TableHead>{t("Email")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {EVENTS.map(([e, label]) => {
                const r = route(e);
                return (
                  <TableRow key={e}>
                    <TableCell className="text-sm">{t(label)}</TableCell>
                    <TableCell>
                      <Switch
                        checked={r.desktop}
                        onCheckedChange={(v) => setRoute(e, { ...r, desktop: v })}
                        aria-label={`${label} desktop`}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={r.push}
                        onCheckedChange={(v) => setRoute(e, { ...r, push: v })}
                        aria-label={`${label} push`}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={r.email}
                        onValueChange={(v) => setRoute(e, { ...r, email: v as Route["email"] })}
                      >
                        <SelectTrigger className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="now">{t("at once")}</SelectItem>
                          <SelectItem value="after-15-min">
                            {t("after 15 min unanswered")}
                          </SelectItem>
                          <SelectItem value="never">{t("never")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label>{t("Quiet hours")}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                className="w-28"
                aria-label={t("From")}
                defaultValue={s.quietHours?.from ?? ""}
                id="qf"
              />
              <span>–</span>
              <Input
                type="time"
                className="w-28"
                aria-label={t("To")}
                defaultValue={s.quietHours?.to ?? ""}
                id="qt"
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const from = (document.getElementById("qf") as HTMLInputElement).value;
              const to = (document.getElementById("qt") as HTMLInputElement).value;
              void update({ quietHours: from && to ? { from, to } : null });
            }}
          >
            {t("Save quiet hours")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Everything but approvals for running jobs waits until they end.")}
          </span>
        </div>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {s.email.server
              ? t("Email: {to} via {host}", { to: s.email.server.to, host: s.email.server.host })
              : t("Set up email")}
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["host", "port", "user", "from", "to"] as const).map((k) => (
              <Input
                key={k}
                aria-label={t(k)}
                placeholder={t(k)}
                value={smtp[k]}
                onChange={(e) => setSmtp({ ...smtp, [k]: e.target.value })}
              />
            ))}
            <Input
              type="password"
              placeholder={t("password (goes to the keychain)")}
              value={smtp.password}
              onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
            />
            <Button
              className="sm:col-span-2"
              onClick={() =>
                act(
                  () =>
                    api.notifications
                      .configureEmail({
                        server: {
                          host: smtp.host,
                          port: Number(smtp.port),
                          secure: Number(smtp.port) === 465,
                          user: smtp.user,
                          from: smtp.from,
                          to: smtp.to,
                        },
                        ...(smtp.password ? { password: smtp.password } : {}),
                      })
                      .then(() => n.reload()),
                  t("Email is set up."),
                )
              }
            >
              {t("Save email")}
            </Button>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

async function subscribePush() {
  // Away from home, the loader holds the subscription (Phase 4, M4.3).
  const away = remote();
  if (away) return away.subscribePush();
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    throw new Error(t("This browser can't receive push notifications."));
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(t("Notifications are blocked for this site in the browser."));
  const key = await api.notifications.vapidPublicKey();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(key),
  });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.notifications.subscribe({ endpoint: json.endpoint, keys: json.keys });
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

const PROVIDERS = [
  {
    kind: "claude-code",
    name: "Claude Code",
    terms: "https://code.claude.com/docs/en/legal-and-compliance",
  },
  { kind: "opencode", name: "OpenCode", terms: null },
  { kind: "antigravity", name: "Antigravity", terms: "https://antigravity.google/terms" },
  { kind: "codex", name: "Codex", terms: "https://openai.com/policies/terms-of-use/" },
];

/** ADR-009: off by default; turning it on is audited. */
/** How many jobs run at once; the rest wait in a queue by priority (ADR-016). */
function JobsLimitCard() {
  const max = useLive(() => api.settings.maxRunningJobs(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const tasks = useLive(() => api.settings.maxTasksPerJob(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  // The ladder's top: how much of a job may run on Claude (ADR-052 §3).
  const share = useLive(() => api.settings.claudeShare(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Jobs at once")}</CardTitle>
        <CardDescription>
          {t(
            "How many jobs run together. Others wait in a queue, highest priority first, and start when one ends. A job waiting for you takes no place.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Select
          value={String(max.data ?? 4)}
          onValueChange={(v) =>
            act(
              () => api.settings.setMaxRunningJobs({ max: Number(v) }),
              t("Saved; queued jobs start if there is room."),
            )
          }
        >
          <SelectTrigger
            data-help="settings.jobs-at-once"
            className="w-40"
            aria-label={t("Jobs at once")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t("{n} jobs at once", { n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={tasks.data == null ? "auto" : String(tasks.data)}
          onValueChange={(v) =>
            act(
              () => api.settings.setMaxTasksPerJob({ max: v === "auto" ? null : Number(v) }),
              t("Saved; it applies to the next tasks."),
            )
          }
        >
          <SelectTrigger
            data-help="settings.tasks-at-once"
            className="w-52"
            aria-label={t("Tasks at once in a job")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("A job runs what is admitted")}</SelectItem>
            {[1, 2, 3, 4].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 1 ? t("1 task at a time in a job") : t("{n} tasks at once in a job", { n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="w-full text-xs text-muted-foreground">
          {t(
            "Tasks that need nothing of each other run together by default, each in its own worktree, merged and checked again; only tasks that change the same files wait for each other.",
          )}
        </p>
        <Select
          value={share.data == null ? "auto" : String(share.data)}
          onValueChange={(v) =>
            act(
              () => api.settings.setClaudeShare({ share: v === "auto" ? null : Number(v) }),
              t("Saved; it applies to the next tasks."),
            )
          }
        >
          <SelectTrigger
            data-help="settings.claude-share"
            className="w-60"
            aria-label={t("Claude share of a job")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("Claude as needed")}</SelectItem>
            {[0, 0.25, 0.5, 0.75].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 0
                  ? t("Claude only when nothing else can")
                  : t("Claude for at most {n}% of a job", { n: n * 100 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="w-full text-xs text-muted-foreground">
          {t(
            "A task starts on the cheapest model likely to do it and climbs to a stronger one when it fails; Claude is the top. Its share caps how much of a job may run on Claude.",
          )}
        </p>
      </CardContent>
    </Card>
  );
}

const GB = 1024 ** 3;

/**
 * Parallel by default, admitted by resources (ADR-050): how many tasks at
 * once across all jobs, the thresholds that hold work back, and whether my
 * own work on the computer pauses Oraknid's.
 */
function WorkAtOnceCard() {
  const r = useLive(() => api.settings.resources(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  if (!r.data) return null;
  const s = r.data;
  const th = {
    minFreeMemory: 0.15,
    maxCpu: 0.85,
    minFreeDiskBytes: 2 * GB,
    heavyAtOnce: 1,
    ...s.thresholds,
  };
  const save = (patch: Parameters<typeof api.settings.setResources>[0]) =>
    act(() => api.settings.setResources(patch), t("Saved; it applies to the next tasks."));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Work at once")}</CardTitle>
        <CardDescription>
          {t(
            "Every task that can run starts at once, as long as this computer has room, its Legs have sessions free and you allow it. A heavy task (a build, an install, a test suite) never runs beside another. When memory runs out Oraknid pauses its newest or heaviest task and tells you; it starts again by itself once there is room.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t("Tasks at once, across all jobs")}</Label>
          <Select
            value={String(s.tasksAtOnce)}
            onValueChange={(v) => save({ tasksAtOnce: v === "auto" ? "auto" : Number(v) })}
          >
            <SelectTrigger data-help="settings.work-at-once" aria-label={t("Tasks at once")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("Automatic: what this computer takes")}</SelectItem>
              {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n === 1 ? t("1 task at a time") : t("{n} tasks at once", { n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Heavy tasks at once")}</Label>
          <Select
            value={String(th.heavyAtOnce)}
            onValueChange={(v) => save({ thresholds: { heavyAtOnce: Number(v) } })}
          >
            <SelectTrigger aria-label={t("Heavy tasks at once")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {String(n)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Keep this much memory free")}</Label>
          <Select
            value={String(Math.round(th.minFreeMemory * 100))}
            onValueChange={(v) => save({ thresholds: { minFreeMemory: Number(v) / 100 } })}
          >
            <SelectTrigger aria-label={t("Keep this much memory free")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 15, 20, 25, 30, 40].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {`${n}%`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("No new task above this CPU use")}</Label>
          <Select
            value={String(Math.round(th.maxCpu * 100))}
            onValueChange={(v) => save({ thresholds: { maxCpu: Number(v) / 100 } })}
          >
            <SelectTrigger aria-label={t("No new task above this CPU use")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 60, 70, 80, 85, 90, 95].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {`${n}%`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Keep this much disk free")}</Label>
          <Select
            value={String(Math.round(th.minFreeDiskBytes / GB))}
            onValueChange={(v) => save({ thresholds: { minFreeDiskBytes: Number(v) * GB } })}
          >
            <SelectTrigger aria-label={t("Keep this much disk free")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 5, 10, 20].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {`${n} GB`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 self-end">
          <Switch
            id="pause-for-my-work"
            checked={s.pauseForMyWork}
            onCheckedChange={(on) => save({ pauseForMyWork: on })}
          />
          <Label htmlFor="pause-for-my-work">
            {t("Pause work when the computer is busy with my own things")}
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

function FallbackCard() {
  const on = useLive(() => api.settings.sameProviderFallback(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "policy.same-provider-fallback",
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Same-provider fallback")}</CardTitle>
        <CardDescription>
          {t(
            "When one account hits its usage limit, may Oraknid move the task to another of my accounts with the same provider? Off, it waits for the reset or uses another provider. Providers' terms may treat rotating accounts to get around limits as circumvention: read them before turning this on.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {PROVIDERS.map((p) => (
          <div key={p.kind} className="flex items-center gap-2 text-sm">
            <Switch
              id={`fb-${p.kind}`}
              checked={(on.data ?? []).includes(p.kind)}
              onCheckedChange={(v) =>
                act(
                  () => api.settings.setSameProviderFallback({ kind: p.kind, enabled: v }),
                  v ? t("On, and recorded in the audit log.") : t("Off."),
                )
              }
            />
            <Label htmlFor={`fb-${p.kind}`}>{p.name}</Label>
            {p.terms ? (
              <a
                href={p.terms}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline underline-offset-2"
              >
                {t("terms")}
              </a>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PolicyCard() {
  return (
    <RulesCard
      scope="global"
      title={t("Commands")}
      description={t(
        "My rules for every job (patterns). A job's rules win, then its project's; deny beats allow; the never-allowed list always stands.",
      )}
      load={() => api.policies.get()}
      save={(r) => api.policies.update(r)}
    />
  );
}

function DevicesCard() {
  const d = useLive(() => api.devices.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("device."),
  });
  const [code, setCode] = useState<string | null>(null);
  // Giving or taking full rights asks for the PIN again (ADR-030).
  const [rights, setRights] = useState<{ id: string; name: string; full: boolean } | null>(null);
  const [pin, setPin] = useState("");
  const remoteHere = !!remote();
  const { confirm, dialog } = useConfirm();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Devices")}</CardTitle>
        <CardDescription>{t("Browsers and phones paired with this Oraknid.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ErrorNote error={d.error} />
        {(d.data ?? []).map((x) => (
          <div key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={`min-w-0 truncate ${x.revokedAt ? "line-through opacity-60" : ""}`}
              title={x.name}
            >
              {x.name}
            </span>
            {x.rights === "full" && !x.revokedAt ? (
              <Badge variant="destructive" className="h-5 text-[10px]">
                {t("full rights")}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {x.lastSeenAt
                ? t("seen {when}", { when: ago(x.lastSeenAt) })
                : t("paired {when}", { when: ago(x.pairedAt) })}
            </span>
            <span className="flex-1" />
            {!x.revokedAt && !remoteHere ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPin("");
                  setRights({ id: x.id, name: x.name, full: x.rights !== "full" });
                }}
              >
                {x.rights === "full" ? t("Take full rights") : t("Give full rights")}
              </Button>
            ) : null}
            {!x.revokedAt ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={async () => {
                  if (
                    await confirm(
                      t("Revoke {name}?", { name: x.name }),
                      t("It is signed out at once and must be paired again to come back."),
                      t("Revoke"),
                      { keep: t("Keep it") },
                    )
                  )
                    void act(
                      () => api.devices.revoke({ id: x.id }).then(() => d.reload()),
                      t("Revoked."),
                    );
                }}
              >
                {t("Revoke")}
              </Button>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => act(async () => setCode((await api.devices.pairStart()).code))}
          >
            {t("Pair a new device")}
          </Button>
          {code ? (
            <span className="text-sm">
              {t("Enter")}{" "}
              <code className="rounded bg-muted px-1.5 font-mono text-base tracking-widest">
                {code}
              </code>{" "}
              {t("on the new device within 5 minutes.")}
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (
                !(await confirm(
                  t("Unpair this device?"),
                  t("This browser forgets Oraknid; pairing it again needs a new code."),
                  t("Unpair"),
                  { keep: t("Stay paired") },
                ))
              )
                return;
              auth.set(null);
              location.reload();
            }}
          >
            {t("Unpair this device")}
          </Button>
        </div>
        <Dialog open={!!rights} onOpenChange={(o) => !o && setRights(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {rights?.full
                  ? t("Give full rights to {name}?", { name: rights?.name ?? "" })
                  : t("Take full rights from {name}?", { name: rights?.name ?? "" })}
              </DialogTitle>
              <DialogDescription>
                {rights?.full
                  ? t(
                      "Away from home too, it can then open a terminal, reach your servers, and change projects, Legs, tools and command rules. Only your PIN stands between a thief and your computer.",
                    )
                  : t(
                      "Away from home it goes back to following, answering, approving and starting jobs.",
                    )}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!rights) return;
                void act(
                  () =>
                    api.devices.setRights({ id: rights.id, full: rights.full, pin }).then(() => {
                      setRights(null);
                      d.reload();
                    }),
                  rights.full ? t("Full rights given.") : t("Full rights taken."),
                );
              }}
            >
              <Label htmlFor="rights-pin">{t("Your PIN")}</Label>
              <Input
                id="rights-pin"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setRights(null)}>
                  {t("Cancel")}
                </Button>
                <Button
                  type="submit"
                  variant={rights?.full ? "destructive" : "default"}
                  disabled={!pin}
                >
                  {rights?.full ? t("Give full rights") : t("Take full rights")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        {dialog}
      </CardContent>
    </Card>
  );
}

function ThemeCard() {
  const { choice, set } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Look")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {(["dark", "light", "system"] as ThemeChoice[]).map((c) => (
          <Button
            key={c}
            variant={choice === c ? "default" : "secondary"}
            aria-pressed={choice === c}
            onClick={() => set(c)}
          >
            {t(c === "system" ? "Follow the system" : c === "dark" ? "Dark" : "Light")}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
