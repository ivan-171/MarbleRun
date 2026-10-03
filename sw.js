const CACHE = 'marbleforge-v0.1.2';
const SHELL = [
  './','./index.html','./styles.css','./src/app.js','./src/engine.js','./src/logic.js',
  './manifest.webmanifest','./assets/icon-192.png','./assets/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const freshAsset = sameOrigin && ['document','script','style','manifest'].includes(event.request.destination);

  // Installed iPhone PWAs must see a newly deployed build without deleting
  // the Home Screen icon. HTML/JS/CSS therefore prefer the network.
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  if (freshAsset) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Pinned third-party modules and immutable images are safe to reuse offline.
  event.respondWith(cacheFirst(event.request));
});
