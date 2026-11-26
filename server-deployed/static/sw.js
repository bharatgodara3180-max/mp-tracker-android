/* MP Tracker service worker: keeps the face models and app files on the device so the
   Gate / Deploy apps open instantly (the 7 MB models are downloaded only once).
   Live data (/api/) is never cached. */
const MODELS = 'mp-models-v1';
const ASSETS = 'mp-assets-v21';
const SHELL = 'mp-shell-v1';
const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json', 'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json', 'face_recognition_model.bin',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(MODELS).then((c) => c.addAll(MODEL_FILES.map((f) => 'models/' + f))).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![MODELS, ASSETS, SHELL].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(cacheName, req) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

// app files (/assets/): always ask the server first (a cheap 304 when unchanged), the saved copy is only the offline fallback,
// so a patched file can never be shadowed by an older copy of the same name
async function assetsFresh(req) {
  const c = await caches.open(ASSETS);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true }) || await c.match('./', { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/models/')) { e.respondWith(cacheFirst(MODELS, req)); return; }
  if (url.pathname.includes('/assets/')) { e.respondWith(assetsFresh(req)); return; }
  e.respondWith(networkFirst(req));                                                            // index.html, manifests, icons
});
