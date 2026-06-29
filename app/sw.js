/* ═══════════════════════════════════════
   TRAILRUN PWA — Service Worker
   Estrategia: Cache-first para assets,
   Network-first para tiles de mapa
═══════════════════════════════════════ */

const CACHE_NAME   = 'trailrun-v2';
const TILE_CACHE   = 'trailrun-tiles-v2';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/deck.gl@9.0.0/dist.min.js',
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== TILE_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Tiles CARTO (mapa 3D): misma estrategia que OSM
  if (url.includes('basemaps.cartocdn.com') && !url.includes('style.json')) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // Tiles OSM: Cache con expiración (stale-while-revalidate)
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // Fuentes Google: network-first
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(networkFirst(e.request, CACHE_NAME));
    return;
  }

  // Assets propios: cache-first
  e.respondWith(cacheFirst(e.request));
});

// ─── ESTRATEGIAS ─────────────────────────────────────────────────────────────
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req, cacheName) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function tileStrategy(req) {
  // Servir desde caché si existe (tiles no cambian frecuentemente)
  const cached = await caches.match(req);
  if (cached) {
    // Revalidar en background
    fetch(req).then(resp => {
      if (resp.ok) {
        caches.open(TILE_CACHE).then(c => c.put(req, resp));
      }
    }).catch(() => {});
    return cached;
  }

  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(TILE_CACHE);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    // Tile no disponible offline — devolver transparente 1x1
    return new Response(
      new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,92,114,166,134,0,0,0,11,73,68,65,84,120,156,98,0,0,0,2,0,1,227,69,8,41,0,0,0,0,73,69,78,68,174,66,96,130]),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}
