import { useEffect, useState } from "react";
import { Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { LockScreen } from "@/components/lock-screen";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, auth, setOnUnauthorized } from "@/lib/api";
import { live } from "@/lib/live";
import { unlock } from "@/lib/lock";
import { remote } from "@/lib/remote";
import { ThemeProvider } from "@/lib/theme";
import { ChatsPage } from "@/pages/chats";
import { InboxPage } from "@/pages/inbox";
import { JobPage } from "@/pages/job";
import { JobsPage } from "@/pages/jobs";
import { LegsPage } from "@/pages/legs";
import { LogsPage } from "@/pages/logs";
import { MailPage } from "@/pages/mail";
import { OverviewPage } from "@/pages/overview";
import { PairPage } from "@/pages/pair";
import { ProjectsPage } from "@/pages/projects";
import { ServersPage } from "@/pages/servers";
import { SettingsPage } from "@/pages/settings";
import { SkillsPage } from "@/pages/skills";
import { TerminalPage } from "@/pages/terminal";
import { WorkPage } from "@/pages/work";

export function App() {
  const [paired, setPaired] = useState(() => !!auth.token());

  useEffect(() => {
    setOnUnauthorized(() => {
      auth.set(null);
      live.stop();
      setPaired(false);
    });
  }, []);

  // `oraknid open` puts a one-time code in the address: this browser pairs itself.
  useEffect(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    api.devices
      .pairComplete({ code, name: deviceName() })
      .then(({ token }) => {
        auth.set(token);
        setPaired(true);
      })
      .catch(() => {});
  }, []);

  // The lock (ADR-029): paired is not enough, this device must be unlocked.
  const [lock, setLock] = useState<
    | { state: "checking" }
    | { state: "locked"; pinSet: boolean; remote: boolean }
    | { state: "open"; idleMinutes: number }
  >({ state: "checking" });
  const check = () => {
    api.lock
      .status()
      .then((s) =>
        setLock(
          s.unlocked
            ? { state: "open", idleMinutes: s.idleMinutes }
            : { state: "locked", pinSet: s.pinSet, remote: s.remote },
        ),
      )
      .catch(() => setLock({ state: "locked", pinSet: true, remote: !!remote() }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: check reads only setters and the API
  useEffect(() => {
    if (paired) check();
    return unlock.onLocked(() => {
      live.stop();
      check();
    });
  }, [paired]);

  useEffect(() => {
    if (paired && lock.state === "open") live.start();
  }, [paired, lock.state]);

  // Idle, this device locks itself: no touch, click or key for the chosen time.
  const idleMinutes = lock.state === "open" ? lock.idleMinutes : 0;
  useEffect(() => {
    if (!idleMinutes) return;
    let last = Date.now();
    const seen = () => {
      last = Date.now();
    };
    const kinds = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    for (const k of kinds) window.addEventListener(k, seen, { passive: true });
    const timer = setInterval(() => {
      if (Date.now() - last < idleMinutes * 60_000) return;
      void api.lock.lock({ everywhere: false }).catch(() => {});
      unlock.locked();
    }, 15_000);
    return () => {
      clearInterval(timer);
      for (const k of kinds) window.removeEventListener(k, seen);
    };
  }, [idleMinutes]);

  // Away from home the page is the loader's frame (about:srcdoc): routes live in the hash.
  return (
    <Router hook={remote() ? useHashLocation : undefined}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          {paired && lock.state === "checking" ? null : paired && lock.state === "locked" ? (
            <LockScreen pinSet={lock.pinSet} remote={lock.remote} onUnlocked={check} />
          ) : paired ? (
            <Shell>
              <Switch>
                <Route path="/" component={OverviewPage} />
                <Route path="/jobs" component={JobsPage} />
                <Route path="/jobs/new">{() => <WorkPage />}</Route>
                <Route path="/new">{() => <WorkPage />}</Route>
                <Route path="/new/:id">{(p) => <WorkPage key={p.id} draftId={p.id} />}</Route>
                <Route path="/jobs/:id">{(p) => <JobPage id={p.id} />}</Route>
                <Route path="/projects" component={ProjectsPage} />
                <Route path="/inbox">{() => <InboxPage />}</Route>
                <Route path="/inbox/:id">{(p) => <InboxPage focus={p.id} />}</Route>
                <Route path="/legs">{() => <LegsPage />}</Route>
                <Route path="/legs/:id">{(p) => <LegsPage focus={p.id} />}</Route>
                <Route path="/skills" component={SkillsPage} />
                <Route path="/chats">{() => <ChatsPage />}</Route>
                <Route path="/mail">{() => <MailPage />}</Route>
                <Route path="/mail/:account">{(p) => <MailPage account={p.account} />}</Route>
                <Route path="/mail/:account/:folder">
                  {(p) => <MailPage account={p.account} folder={p.folder} />}
                </Route>
                <Route path="/mail/:account/:folder/:thread">
                  {(p) => <MailPage account={p.account} folder={p.folder} thread={p.thread} />}
                </Route>
                <Route path="/servers" component={ServersPage} />
                <Route path="/terminal">{() => <TerminalPage />}</Route>
                <Route path="/terminal/:target">{(p) => <TerminalPage target={p.target} />}</Route>
                <Route path="/chats/:id">{(p) => <ChatsPage id={p.id} />}</Route>
                <Route path="/logs" component={LogsPage} />
                <Route path="/settings">{() => <SettingsPage />}</Route>
                <Route path="/settings/:tab">{(p) => <SettingsPage tab={p.tab} />}</Route>
                <Route>
                  <OverviewPage />
                </Route>
              </Switch>
            </Shell>
          ) : (
            <PairPage onPaired={() => setPaired(true)} />
          )}
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </Router>
  );
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac/.test(ua)
        ? "Mac"
        : /Linux/.test(ua)
          ? "Linux"
          : /Windows/.test(ua)
            ? "Windows"
            : "Device";
  const browser = /Firefox/.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}
