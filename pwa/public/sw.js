const CACHE_NAME = 'deals-digest-v1';
const ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network first for API, cache first for assets
  if (e.request.url.includes('/api/') || e.request.url.includes('/digest') || e.request.url.includes('/feedback')) {
    return; // let it pass through
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
