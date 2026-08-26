// sw.js — offline support for "Vuelos Americanos GPS"
//
// Two caches:
//  - SHELL_CACHE: the app itself (HTML/CSS/JS/fonts) so the app opens at all
//    with no connection.
//  - TILE_CACHE: map tiles from the WMS + ArcGIS "export" endpoints. This is
//    the one the "Guardar zona sin conexión" feature in index.html fills by
//    firing a fetch() for every tile in the chosen area/zoom range — this
//    worker just needs to notice those requests and cache them, cache-first.
//
// Nothing here is Galicia-specific; any IGN/IDEG/Catastro host works.

const SHELL_CACHE = 'vuelos-shell-v1';
const TILE_CACHE = 'vuelos-tiles-v1';

const TILE_HOSTS = [
  'www.ign.es',
  'ideg.xunta.gal',
  'ovc.catastro.meh.es'
];

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Fetch each shell asset individually (not cache.addAll) so a single
      // missing/blocked asset — e.g. manifest.json not deployed yet —
      // doesn't abort the whole install.
      await Promise.all(SHELL_ASSETS.map(async (asset) => {
        try {
          const req = new Request(asset, { mode: 'no-cors' });
          const res = await fetch(req);
          await cache.put(asset, res);
        } catch (err) {
          // Ignore — that asset just won't be pre-cached on install.
        }
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((n) => n !== SHELL_CACHE && n !== TILE_CACHE)
        .map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return TILE_HOSTS.some((host) => url.hostname === host);
}

async function reportTileCacheFailure(url, err) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach((client) => {
    client.postMessage({ type: 'TILE_CACHE_ERROR', url, message: err && err.message });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }

  if (isTileRequest(url)) {
    // Cache-first: a tile once saved never needs to be re-fetched (these
    // historical flights don't change), and it's what lets the app work
    // with zero signal.
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const response = await fetch(req);
          try {
            // Awaited + caught on its own: if this fails (most commonly a
            // QuotaExceededError from the device running out of storage —
            // opaque cross-origin responses like these get padded well
            // beyond their real size for privacy reasons, so quota fills
            // up faster than you'd expect), we now actually notice, instead
            // of it being a silently-dropped promise rejection.
            await cache.put(req, response.clone());
          } catch (cacheErr) {
            reportTileCacheFailure(req.url, cacheErr);
          }
          return response;
        } catch (err) {
          // Offline and not cached: let it fail, Leaflet just shows a
          // blank tile there instead of crashing the app.
          return Response.error();
        }
      })
    );
    return;
  }

  // App shell / everything else: network-first so you always get the
  // latest version when online, falling back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req))
  );
});

// Lets the page ask "how much tile data do we actually have cached?" and
// "wipe it" without duplicating cache-key logic in index.html.
self.addEventListener('message', (event) => {
  if (event.data === 'CLEAR_TILE_CACHE') {
    event.waitUntil(caches.delete(TILE_CACHE));
  }
});
