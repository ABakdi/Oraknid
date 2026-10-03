// The Nest's service worker: notifications from my daemon while I'm away
// (Phase 4, M4.3). Pushes come from the push service, encrypted to this
// browser; The Nest never sees them. It caches nothing.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const n = e.data ? e.data.json() : { title: "Oraknid", body: "" };
  e.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag || undefined,
      icon: "/app/icon.svg",
      requireInteraction: n.urgency === "critical",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((all) => {
      const open = all.find((c) => new URL(c.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow("/");
    }),
  );
});
