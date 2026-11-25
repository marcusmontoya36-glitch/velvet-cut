// Offline cache for the app shell + ffmpeg engine. User media never goes through here (blob: URLs).
// The 31 MB ffmpeg core lives in its own cache bucket (vc-core-v1) so app updates don't re-download it.
const V = 'vc-v12';
const CORE = 'vc-core-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'render.js', 'fx.js', 'wcexport.js', 'multicam.js', 'framing.js', 'vendor/mediapipe/vision_bundle.mjs', 'vendor/webcodecs/mp4box.js', 'vendor/webcodecs/mp4-muxer.js', 'exporter.js', 'ai.js', 'autoedit.js', 'hooks.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'vendor/blank.mp4', 'vendor/ffmpeg/index.js', 'vendor/ffmpeg/classes.js', 'vendor/ffmpeg/const.js',
  'vendor/ffmpeg/errors.js', 'vendor/ffmpeg/types.js', 'vendor/ffmpeg/utils.js', 'vendor/ffmpeg/worker.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== CORE).map(async k => {
    // migrate an engine cached by older versions instead of downloading it again
    if (k.startsWith('vc-v')) {
      const old = await caches.open(k), core = await caches.open(CORE);
      for (const req of await old.keys()) if (req.url.includes('/vendor/ffmpeg/core/') && !(await core.match(req))) { const r = await old.match(req); if (r) await core.put(req, r); }
    }
    return caches.delete(k);
  }))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.includes('/vendor/ffmpeg/core/') || (u.pathname.includes('/vendor/mediapipe/') && !u.pathname.endsWith('.mjs'))) {
    // cache-first for the big wasm engine
    e.respondWith(caches.open(CORE).then(c => c.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
  } else {
    // network-first for app code (so updates land), offline fallback from cache
    e.respondWith(fetch(e.request).then(res => { if (res.ok) { const cl = res.clone(); caches.open(V).then(c => c.put(e.request, cl)); } return res; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
