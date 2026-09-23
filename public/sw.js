// Minimal app-shell cache. API calls always hit the network — we never want
// stale tasks/finance data served from cache. Bump CACHE_NAME to force
// clients to pick up new static assets after a deploy.
const CACHE_NAME = 'core-pa-v6';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/favicon.png',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
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

  const taskId = data.data?.taskId;
  e.waitUntil(
    self.registration.showNotification(data.title || 'Core PA', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      // Same task re-pinging replaces its own earlier notification instead of
      // stacking duplicates; a different task or alert type never clobbers it.
      tag: taskId ? `core-pa-task-${taskId}` : `core-pa-${(data.title || 'reminder').toLowerCase()}`,
      renotify: true,
      data: data.data || null,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const taskId = e.notification.data?.taskId;
  const targetUrl = taskId ? `/?action=task&id=${taskId}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});