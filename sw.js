// Offline cache for the app shell + ffmpeg engine. User media never goes through here (blob: URLs).
const V = 'vc-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'render.js', 'exporter.js', 'ai.js', 'hooks.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'vendor/ffmpeg/index.js', 'vendor/ffmpeg/classes.js', 'vendor/ffmpeg/const.js',
  'vendor/ffmpeg/errors.js', 'vendor/ffmpeg/types.js', 'vendor/ffmpeg/utils.js', 'vendor/ffmpeg/worker.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const isCore = u.pathname.includes('/vendor/ffmpeg/core/');
  // network-first for app code (so updates land), cache-first for the big wasm
  if (isCore) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cl = res.clone(); caches.open(V).then(c => c.put(e.request, cl)); return res; })));
  } else {
    e.respondWith(fetch(e.request).then(res => { const cl = res.clone(); caches.open(V).then(c => c.put(e.request, cl)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
