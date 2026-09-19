const CACHE_NAME = 'garchitects-hrms-v3';
const SHELL_URLS = [
  '/',
  '/login',
  '/admin',
  '/css/main.css',
  '/css/payroll.css',
  '/js/auth.js',
  '/js/dashboard.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache API
  if (url.pathname.startsWith('/api/')) return;
  const isNavigation = req.mode === 'navigate' ||
    req.destination === 'document' ||
    (req.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    // Network-first for pages: a fresh deployment must never be hidden behind a
    // stale service-worker cache (the old cache-first handler froze pages like
    // /admin/project-management so UI fixes never reached users).
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // Cache-first for static assets (css/js/images/manifest).
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'G-Architects HRMS';
  const options = {
    body: data.body || '',
    icon: '/assets/images/icon-192.png',
    badge: '/assets/images/icon-192.png',
    data: { url: data.url || '/employee/announcements' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if (c.url.includes(url) && 'focus' in c) return c.focus();
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
