// Lets the app open without internet. Always tries the network first,
// so new versions show up right away; the saved copy is only a fallback.
const CACHE = "todo-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
