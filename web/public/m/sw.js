// Service worker for the phone control page (scope /m/). Its one job: show the
// notification the service pushes when a task on the desktop finishes or waits
// on its user, and open the page when it is tapped. It caches nothing — the
// page always talks to the live desktop.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || "Lily 手机控制", {
    body: data.body || "",
    tag: data.tag || "lily",
    renotify: true,
    icon: "/brand/icon-192.png",
    badge: "/brand/icon-192.png",
    data: { url: data.url || "/m/pair" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/m/pair";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((w) => new URL(w.url).pathname.startsWith("/m/"));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
