// Minimal app-shell cache. API calls always hit the network — we never want
// stale tasks/finance data served from cache. Bump CACHE_NAME to force
// clients to pick up new static assets after a deploy.
const CACHE_NAME = 'core-pa-v5';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api')) return; // never cache API calls

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ── Push notifications ──────────────────────────────────────────────────────
// This is what actually reaches a phone: the OS wakes the service worker even
// when Core PA isn't open, unlike the old client-side Notification() call
// which only fired while the tab itself was running.

self.addEventListener('push', (e) => {
  let data = { title: 'Core PA', body: 'You have a reminder.' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title || 'Core PA', {
      body: data.body || '',
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: 'core-pa-reminder',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/app.html');
    })
  );
});