// オフライン用 Service Worker。
// キャッシュを先に返し、オンライン時は裏で最新版を取得して次回起動時に反映する。
// アプリのファイルを更新したら CACHE_VERSION を上げる。
const CACHE_VERSION = "marche-stock-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./vendor/qrcode.min.js",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // app.js?v=... のようなクエリ違いも同じファイルとして扱う。
    const cached = request.mode === "navigate"
      ? await cache.match("./index.html")
      : await cache.match(request, { ignoreSearch: true });
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request.mode === "navigate" ? "./index.html" : request.url.split("?")[0], response.clone());
        return response;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || new Response("オフラインのため読み込めません", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});
