import { useEffect, useState } from "react";
import { Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, auth, setOnUnauthorized } from "@/lib/api";
import { live } from "@/lib/live";
import { remote } from "@/lib/remote";
import { ThemeProvider } from "@/lib/theme";
import { ChatsPage } from "@/pages/chats";
import { InboxPage } from "@/pages/inbox";
import { JobPage } from "@/pages/job";
import { JobsPage } from "@/pages/jobs";
import { LegsPage } from "@/pages/legs";
import { LogsPage } from "@/pages/logs";
import { OverviewPage } from "@/pages/overview";
import { PairPage } from "@/pages/pair";
import { ProjectsPage } from "@/pages/projects";
import { SettingsPage } from "@/pages/settings";
import { SkillsPage } from "@/pages/skills";
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

  useEffect(() => {
    if (paired) live.start();
  }, [paired]);

  // Away from home the page is the loader's frame (about:srcdoc): routes live in the hash.
  return (
    <Router hook={remote() ? useHashLocation : undefined}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          {paired ? (
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
                <Route path="/chats/:id">{(p) => <ChatsPage id={p.id} />}</Route>
                <Route path="/logs" component={LogsPage} />
                <Route path="/settings" component={SettingsPage} />
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
