import type { EyeModels, NotificationSettings, NotifyEvent, Route } from "@oraknid/contracts";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { AwayCard, PhoneCard } from "@/components/away-card";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import { GitHubCard } from "@/components/github-card";
import { LockCard } from "@/components/lock-card";
import { RulesCard } from "@/components/rules-card";
import { StorageCard } from "@/components/storage-card";
import { TerminalCard } from "@/components/terminal-card";
import { ToolsCard } from "@/components/tools-card";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, auth, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
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
] as const;
type TabId = (typeof TABS)[number]["id"];

export function SettingsPage({ tab }: { tab?: string }) {
  const [, go] = useLocation();
  const current: TabId = TABS.some((x) => x.id === tab) ? (tab as TabId) : "general";
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t("Settings")} />
      <Tabs value={current} onValueChange={(v) => go(`/settings/${v}`)}>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            {TABS.map((x) => (
              <TabsTrigger key={x.id} value={x.id} className="px-3">
                {t(x.label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="general" className="space-y-6 pt-2">
          <Section title={t("This computer")}>
            <SystemCard />
            <StorageCard />
          </Section>
          <Section title={t("Notifications")}>
            <NotificationsCard />
          </Section>
          <Section title={t("Look")}>
            <ThemeCard />
          </Section>
        </TabsContent>
        <TabsContent value="work" className="space-y-6 pt-2">
          <Section title={t("The Eye")}>
            <EyeCard />
          </Section>
          <Section title={t("Running jobs")}>
            <JobsLimitCard />
            <FallbackCard />
          </Section>
        </TabsContent>
        <TabsContent value="security" className="space-y-6 pt-2">
          <Section title={t("Unlocking")}>
            <LockCard />
          </Section>
          <Section title={t("What agents may run")}>
            <PolicyCard />
          </Section>
          <Section title={t("Terminal")}>
            <TerminalCard />
          </Section>
        </TabsContent>
        <TabsContent value="devices" className="space-y-6 pt-2">
          <Section title={t("Your phone, from anywhere")}>
            <PhoneCard />
          </Section>
          <Section title={t("Paired devices")}>
            <DevicesCard />
          </Section>
          <Section title={t("The Nest")}>
            <AwayCard />
          </Section>
        </TabsContent>
        <TabsContent value="connections" className="space-y-6 pt-2">
          <Section title={t("GitHub")}>
            <GitHubCard />
          </Section>
          <Section title={t("Tools for skills")}>
            <ToolsCard />
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
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
      <span className="w-36 shrink-0 font-medium">{label}</span>
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
        {row(t("Service"), d.service.startsAtBoot, d.service.detail)}
        {!d.secrets.available ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Input
              type="password"
              className="w-64"
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
      </CardContent>
    </Card>
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
              <Input type="time" className="w-28" defaultValue={s.quietHours?.from ?? ""} id="qf" />
              <span>–</span>
              <Input type="time" className="w-28" defaultValue={s.quietHours?.to ?? ""} id="qt" />
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
          value={String(max.data ?? 2)}
          onValueChange={(v) =>
            act(
              () => api.settings.setMaxRunningJobs({ max: Number(v) }),
              t("Saved; queued jobs start if there is room."),
            )
          }
        >
          <SelectTrigger className="w-40" aria-label={t("Jobs at once")}>
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
          value={String(tasks.data ?? 1)}
          onValueChange={(v) =>
            act(
              () => api.settings.setMaxTasksPerJob({ max: Number(v) }),
              t("Saved; it applies to the next tasks."),
            )
          }
        >
          <SelectTrigger className="w-52" aria-label={t("Tasks at once in a job")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 1 ? t("1 task at a time in a job") : t("{n} tasks at once in a job", { n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="w-full text-xs text-muted-foreground">
          {t(
            "Tasks of one job run together only when they touch different files; each works in its own worktree and is merged, then checked again.",
          )}
        </p>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Devices")}</CardTitle>
        <CardDescription>{t("Browsers and phones paired with this Oraknid.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ErrorNote error={d.error} />
        {(d.data ?? []).map((x) => (
          <div key={x.id} className="flex items-center gap-2 text-sm">
            <span className={x.revokedAt ? "line-through opacity-60" : ""}>{x.name}</span>
            <span className="text-xs text-muted-foreground">
              {x.lastSeenAt
                ? t("seen {when}", { when: ago(x.lastSeenAt) })
                : t("paired {when}", { when: ago(x.pairedAt) })}
            </span>
            <span className="flex-1" />
            {!x.revokedAt ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() =>
                  act(() => api.devices.revoke({ id: x.id }).then(() => d.reload()), t("Revoked."))
                }
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
            onClick={() => {
              auth.set(null);
              location.reload();
            }}
          >
            {t("Unpair this device")}
          </Button>
        </div>
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
      <CardContent className="flex gap-2">
        {(["dark", "light", "system"] as ThemeChoice[]).map((c) => (
          <Button key={c} variant={choice === c ? "default" : "secondary"} onClick={() => set(c)}>
            {t(c === "system" ? "Follow the system" : c === "dark" ? "Dark" : "Light")}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
