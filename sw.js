// Cache-first service worker. Bump CACHE_VERSION on every deploy:
// the byte change makes the app show its "update ready" pill.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `mcf-planner-${CACHE_VERSION}`;
const FONT_CACHE = 'mcf-planner-fonts';
const PRECACHE = ['./', 'index.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))))));
  // No skipWaiting: the new version waits until the user taps the update pill.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('mcf-planner-') && k !== CACHE_NAME && k !== FONT_CACHE)
        .map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Fonts: serve from cache, refresh in the background, so text keeps its fonts offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONT_CACHE).then((cache) => cache.match(req).then((cached) => {
      const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
                            .catch(() => cached);
      return cached || net;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Moodle deadlines change: always go to the network (the app keeps its own offline copy).
  if (url.pathname.endsWith('/data/moodle.json.enc')) return;
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
  }));
});
