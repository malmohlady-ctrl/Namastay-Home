/* Namastay Home service worker — cache-first offline support */
const CACHE = "yoga-v14";
const ASSETS = [
  "./",
  "index.html",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "player.js",
  "player.css",
  "voice/back-00-mid.mp3",
  "voice/back-00-name.mp3",
  "voice/back-01-mid.mp3",
  "voice/back-01-name.mp3",
  "voice/back-03-mid.mp3",
  "voice/back-03-name.mp3",
  "voice/back-05-mid.mp3",
  "voice/back-05-name.mp3",
  "voice/back-07-mid.mp3",
  "voice/back-07-name.mp3",
  "voice/back-09-mid.mp3",
  "voice/back-09-name.mp3",
  "voice/back-11-mid.mp3",
  "voice/back-11-name.mp3",
  "voice/fixed-complete.mp3",
  "voice/fixed-resume.mp3",
  "voice/fixed-test.mp3",
  "voice/found-00-mid.mp3",
  "voice/found-00-name.mp3",
  "voice/found-01-mid.mp3",
  "voice/found-01-name.mp3",
  "voice/found-03-mid.mp3",
  "voice/found-03-name.mp3",
  "voice/found-05-mid.mp3",
  "voice/found-05-name.mp3",
  "voice/found-07-mid.mp3",
  "voice/found-07-name.mp3",
  "voice/reset-00-mid.mp3",
  "voice/reset-00-name.mp3",
  "voice/reset-01-mid.mp3",
  "voice/reset-01-name.mp3",
  "voice/reset-03-mid.mp3",
  "voice/reset-03-name.mp3",
  "voice/reset-05-mid.mp3",
  "voice/reset-05-name.mp3",
  "voice/reset-07-mid.mp3",
  "voice/reset-07-name.mp3",
  "voice/reset-09-mid.mp3",
  "voice/reset-09-name.mp3",
  "voice/reset-11-mid.mp3",
  "voice/reset-11-name.mp3",
  "voice/reset-13-mid.mp3",
  "voice/reset-13-name.mp3",
  "voice/reset-15-mid.mp3",
  "voice/reset-15-name.mp3",
  "voice/reset-17-mid.mp3",
  "voice/reset-17-name.mp3",
  "voice/reset-19-mid.mp3",
  "voice/reset-19-name.mp3",
  "voice/reset-21-mid.mp3",
  "voice/reset-21-name.mp3",
  "voice/reset-23-mid.mp3",
  "voice/reset-23-name.mp3",
  "voice/reset-25-mid.mp3",
  "voice/reset-25-name.mp3",
  "voice/rest-move-gently.mp3",
  "voice/rest-switch-sides.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Cache each asset on its own: one missing file must never block the update.
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k.startsWith("yoga-")).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Music MP3s: cache-first from CACHE, fetched in full on first play.
   Range requests are served as 206 slices of the cached full file so
   seeking and iOS Safari playback work; 206s are never cached. */
async function serveMusic(request) {
  const cache = await caches.open(CACHE);
  let full = await cache.match(request.url);
  if (!full) {
    full = await fetch(request.url);
    if (full && full.ok) cache.put(request.url, full.clone());
  }
  const range = request.headers.get("range");
  if (!range || !full) return full;
  const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!m) return full;
  const blob = await full.blob();
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), blob.size - 1) : blob.size - 1;
  if (start >= blob.size) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": "bytes */" + blob.size }
    });
  }
  const slice = blob.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Range": "bytes " + start + "-" + end + "/" + blob.size,
      "Content-Length": String(slice.size),
      "Accept-Ranges": "bytes",
      "Content-Type": "audio/mpeg"
    }
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.includes("/music/") && url.pathname.endsWith(".mp3")) {
    event.respondWith(serveMusic(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request))
  );
});

/* pages build refresh 2026-10-20 */
