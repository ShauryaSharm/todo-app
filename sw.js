const CACHE_NAME = "todo-shell-v30";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./ai-config.js",
  "./notify-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ---- Push notifications ----
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "To Do";
  const options = {
    body: data.body || "You have a task due.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tag || "todo-reminder",
    // Buttons let a reminder be dealt with from the lock screen. iOS renders them only
    // from 16.4 and even then inconsistently; where they're missing the notification
    // still opens the app on tap, so this degrades to the old behaviour.
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    data: {
      url: data.url || "./",
      token: data.token || null,
      actionUrl: data.actionUrl || null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open copy of the app, or launch one.
function openApp(target) {
  return clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if ("focus" in w) return w.focus();
    }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  });
}

self.addEventListener("notificationclick", (event) => {
  const info = event.notification.data || {};
  const act = event.action;
  event.notification.close();

  // Tapping the notification body (no action) just opens the app, as before.
  if (act !== "done" && act !== "snooze") {
    event.waitUntil(openApp(info.url || "./"));
    return;
  }

  // A button press must not open the app — the whole point is handling it in place.
  event.waitUntil(
    fetch(info.actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: info.token, action: act, minutes: 60 }),
    })
      .then((r) => {
        if (r.ok) return;
        throw new Error("action rejected: " + r.status);
      })
      .catch(() =>
        // Offline, or the token expired. Say so rather than failing silently — a tap
        // that appears to work but doesn't is worse than no button at all.
        self.registration.showNotification("Couldn't update that task", {
          body: "Tap to open the app and do it there.",
          icon: "icons/icon-192.png",
          badge: "icons/icon-192.png",
          tag: (info.tag || "todo") + "-failed",
          data: { url: info.url || "./" },
        })
      )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first: always try to fetch the latest, fall back to cache when offline.
  // This keeps the app fresh after deploys instead of serving stale files.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
