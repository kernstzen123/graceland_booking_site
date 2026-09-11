// ---------------------------------------------------------------------------
// Service Worker for Graceland Scanner PWA
//
// Strategy:
//   - App shell (HTML, JS, CSS):  cache-first, update in background
//   - API calls:                  network-first, never cached
//   - Static assets (/_next/):    stale-while-revalidate
//
// Also handles Background Sync for offline check-in queue push.
// ---------------------------------------------------------------------------

const CACHE_NAME = 'graceland-scanner-v1';

// Core app shell URLs to precache on install
const APP_SHELL = [
  '/admin/scanner',
  '/manifest.json',
  '/scanner-icon-192.png',
  '/scanner-icon-512.png',
];

// ── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache the app shell. We use addAll which fetches and caches.
      // If any fail (e.g., scanner page not built yet), we still activate.
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('[SW] Failed to cache some app shell resources:', err);
      });
    })
  );
  // Activate immediately without waiting for existing tabs to close
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Never cache API calls — they should go to the network or fail
  if (url.pathname.startsWith('/api/')) return;

  // For the scanner page: cache-first (offline support)
  if (url.pathname === '/admin/scanner') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Network failed — return cached version if we have it
            return cached || new Response('Scanner is offline and not cached yet.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            });
          });

        // Return cached immediately, update in background
        return cached || networkFetch;
      })
    );
    return;
  }

  // For Next.js static assets: stale-while-revalidate
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });

        return cached || networkFetch;
      })
    );
    return;
  }

  // For other static assets (icons, etc.): cache-first
  if (url.pathname.startsWith('/scanner-icon') || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});

// ── Background Sync ────────────────────────────────────────────────────────
// When the browser triggers a sync event (connectivity restored), we push
// the offline check-in queue. The actual sync logic is in the main app code,
// but we signal any open scanner pages to run it.

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-checkins') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        // Notify all open scanner windows to push their sync queue
        for (const client of clients) {
          client.postMessage({ type: 'SYNC_CHECKINS' });
        }
      })
    );
  }
});

// ── Message handler ────────────────────────────────────────────────────────
// Listen for messages from the main app (e.g., to update cache)

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then((cache) => {
      for (const url of urls) {
        cache.add(url).catch(() => {
          // Silently fail for individual URLs
        });
      }
    });
  }
});
