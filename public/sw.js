const STATIC_CACHE = "gongkao-static-v3";
const AUDIO_CACHE = "gongkao-audio-v2";

async function responseFromCachedRange(cache, request) {
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) return null;
  const url = new URL(request.url);
  const cached = await cache.match(url.pathname);
  if (!cached) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
  if (!match) return cached;
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const requestedStart = match[1] ? Number(match[1]) : undefined;
  const requestedEnd = match[2] ? Number(match[2]) : undefined;
  const start = requestedStart ?? Math.max(size - (requestedEnd ?? size), 0);
  const end = Math.min(requestedEnd ?? size - 1, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const chunk = buffer.slice(start, end + 1);
  const headers = new Headers(cached.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(chunk.byteLength));
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  return new Response(chunk, { status: 206, statusText: "Partial Content", headers });
}

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

  if (request.destination === "audio" || url.pathname.startsWith("/audio/")) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        if (request.headers.has("range")) {
          const cachedRange = await responseFromCachedRange(cache, request);
          return cachedRange ?? fetch(request);
        }
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

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
