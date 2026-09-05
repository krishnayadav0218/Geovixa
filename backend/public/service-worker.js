// Bump this on every deploy that changes any cached file — old caches are deleted in
// 'activate' below, so a stale version never lingers on someone's installed app.
const CACHE_VERSION = 'geovixa-shell-v1';

// Only the static app shell is cached. Everything under /api/ or /socket.io/ is
// deliberately NEVER cached — this is a live attendance/SOS system, serving stale data
// there would be actively dangerous (e.g. showing an old, already-resolved SOS alert as
// current). Caching is purely so the shell (HTML/CSS/JS) loads instantly and works
// offline-for-navigation; actual data always requires a live connection.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/realtime.js',
  '/js/dashboardCharts.js',
  '/js/bulkActions.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/img/geovixa-logo.svg',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {
      // Best-effort — if a CDN asset (Chart.js, xlsx, socket.io client) fails to pre-cache
      // this must not block the whole install; those still work fine on next online visit.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls or the Socket.io transport — always hit the network directly.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }
  // Only handle GET requests for the same origin; let everything else (cross-origin CDN
  // scripts, POST/PUT, etc.) pass through untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline — fall back to whatever we have cached, if anything

      // Cache-first for instant loads, but always refresh the cache in the background so the
      // NEXT load picks up any deployed change (classic stale-while-revalidate).
      return cached || networkFetch;
    })
  );
});
