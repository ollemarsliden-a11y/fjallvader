/* Fjällväder service worker.
   Strategi vald för att ALDRIG låsa fast en gammal version (vi har varit där):
   - Sidnavigering: alltid nätet först, cache bara som offline-reserv.
   - Byggda assets (/assets/, hashade filnamn): cache först — de ändrar namn vid varje bygge.
   - Väder-API:er (andra domäner): rörs aldrig av service workern, alltid färskt.
*/
const CACHE = "fjallvader-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // sidan själv: nätet först, cache som offline-reserv
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((m) => m || caches.match("/")))
    );
    return;
  }

  // hashade byggfiler: cache först
  if (url.pathname.startsWith("/assets/") || url.pathname.match(/icon-\d+\.png$/)) {
    e.respondWith(
      caches.match(e.request).then(
        (m) =>
          m ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
      )
    );
  }
});
