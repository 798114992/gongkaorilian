const STATIC_CACHE = "gongkao-static-v3";
// Only AudioHub may explicitly place a reviewed free preview in this cache.
// The service worker never caches an audio response by request destination.
const AUDIO_CACHE = "gongkao-audio-v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== STATIC_CACHE && key !== AUDIO_CACHE)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/admin")
    || url.pathname.startsWith("/signin")
    || url.pathname.startsWith("/logout")
  ) return;

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request).then(async (response) => {
          if (response.ok) await cache.put(request, response.clone());
          return response;
        });
        return cached ?? network;
      }),
    );
  }
});
