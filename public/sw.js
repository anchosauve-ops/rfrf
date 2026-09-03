/* Kairos service worker: shell cache-first, API network-only. */
const SHELL = "kairos-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icons/icon.svg"])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            if (res.ok && (url.pathname.startsWith("/assets/") || url.pathname === "/")) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => caches.match("/")),
    ),
  );
});
