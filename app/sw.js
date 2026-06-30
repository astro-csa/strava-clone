/* ═══════════════════════════════════════
   TRAILRUN PWA — Service Worker
   Estrategia:
   - HTML/JS/CSS propios → network-first
     (así cada deploy se ve de inmediato;
     cache solo como fallback offline)
   - Tiles de mapa → stale-while-revalidate
   - Todo lo demás → cache-first
═══════════════════════════════════════ */

const CACHE_NAME   = 'trailrun-v7';
const TILE_CACHE   = 'trailrun-tiles-v2';

// Archivos propios que cambian con cada deploy: SIEMPRE network-first.
// Si alguno de estos se sirviera cache-first, un SW activo podría quedar
// sirviendo código viejo indefinidamente, incluso con skipWaiting(),
// porque la propia estrategia de caché bloquea ver la versión nueva.
const OWN_ASSETS = ['index.html', 'app.js', 'style.css', 'manifest.json'];

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js',
  'https://unpkg.com/deck.gl@9.0.0/dist.min.js',
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
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

// ─── MENSAJES DESDE EL CLIENTE ────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // La Cache API solo admite peticiones GET. Las POST (ej. Open-Elevation)
  // deben ir directas a la red sin pasar por ninguna estrategia de caché.
  if (e.request.method !== 'GET') return;

  // Navegación HTML (cuando se abre/recarga la app) → network-first siempre,
  // para no quedar nunca atrapados sirviendo un index.html viejo.
  if (e.request.mode === 'navigate' || OWN_ASSETS.some(a => url.endsWith(a))) {
    e.respondWith(networkFirst(e.request, CACHE_NAME));
    return;
  }

  // Tiles CARTO / OSM (mapas): stale-while-revalidate
  if (url.includes('basemaps.cartocdn.com') || url.includes('tile.openstreetmap.org')) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // Fuentes Google: network-first
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(networkFirst(e.request, CACHE_NAME));
    return;
  }

  // Resto de dependencias externas (leaflet, maplibre, deck.gl): cache-first,
  // ya que van pineadas a una versión exacta en la URL y no cambian solas.
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
    // cache: 'no-store' evita que el caché HTTP del navegador (un nivel
    // por debajo del Service Worker) también sirva una copia obsoleta.
    const resp = await fetch(req, { cache: 'no-store' });
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
  const cached = await caches.match(req);
  if (cached) {
    fetch(req).then(resp => {
      if (resp.ok) caches.open(TILE_CACHE).then(c => c.put(req, resp));
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
    return new Response(
      new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,92,114,166,134,0,0,0,11,73,68,65,84,120,156,98,0,0,0,2,0,1,227,69,8,41,0,0,0,0,73,69,78,68,174,66,96,130]),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}
