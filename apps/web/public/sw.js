// Oraknid's service worker: an installable app, the shell offline, and web push (Notifications).
const SHELL = "oraknid-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The app shell comes from the network when it can, the cache when it can't; the API never from the cache.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/live")
    return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
  );
});

self.addEventListener("push", (e) => {
  const n = e.data ? e.data.json() : { title: "Oraknid", body: "" };
  e.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag || undefined,
      icon: "/icon.svg",
      data: { url: n.url || "/" },
      requireInteraction: n.urgency === "critical",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) if ("focus" in c) return c.navigate(url).then(() => c.focus());
      return self.clients.openWindow(url);
    }),
  );
});
