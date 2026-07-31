self.addEventListener("push", (event) => {
  let payload = {
    title: "Switchyard",
    body: "A project needs your attention.",
    kind: "system",
    url: "/",
  };
  try {
    payload = { ...payload, ...(event.data?.json() ?? {}) };
  } catch {
    // Malformed payloads still produce a safe generic notification.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      badge: "/switchyard.svg",
      icon: "/switchyard.svg",
      tag: payload.id ? `switchyard:${payload.id}` : undefined,
      data: { url: payload.url || "/", id: payload.id },
      renotify: payload.kind === "failed" || payload.kind === "needs-input",
      requireInteraction: payload.kind === "needs-input",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = self.location.origin;
  try {
    const candidate = new URL(event.notification.data?.url || "/", self.location.origin);
    if (candidate.origin === self.location.origin) {
      if (event.notification.data?.id)
        candidate.searchParams.set("switchyardEvent", event.notification.data.id);
      target = candidate.href;
    }
  } catch {
    // Invalid deep links fall back to the control-plane root.
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const current = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (current) {
        await current.navigate(target);
        return current.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
