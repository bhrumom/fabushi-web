/* Fabushi Web PWA service worker: static shell only, never durable Agent/API state. */
const url = new URL(self.location.href);
const VERSION = url.searchParams.get("v") || "dev";
const CACHE_PREFIX = "fabushi-web-shell:";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

function isRuntimeRequest(requestUrl) {
  return requestUrl.pathname.startsWith("/api/") ||
    requestUrl.pathname.startsWith("/v1/") ||
    requestUrl.pathname.startsWith("/oauth/") ||
    requestUrl.pathname.startsWith("/auth/");
}

function isStaticAsset(request, requestUrl) {
  return requestUrl.pathname.includes("/_next/static/") ||
    ["script", "style", "font", "image"].includes(request.destination);
}

self.addEventListener("install", () => {
  // Do not skip waiting automatically. The page coordinates a safe handoff.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING" && event.data?.version === VERSION) {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin || isRuntimeRequest(requestUrl)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        const scope = new URL(self.registration.scope);
        const hostUrl = new URL("host/", scope).toString();
        const shell = await caches.match(hostUrl);
        if (shell) return shell;
        return new Response("Fabushi Web is offline. Reconnect to resume your durable Agent run.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
    })());
    return;
  }

  if (isStaticAsset(request, requestUrl)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })());
  }
});
