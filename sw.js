// Service worker : fonctionnement hors connexion (cache de l'application).
const VERSION = 'gp-v1.9.2';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/store.js', './js/sched.js', './js/util.js', './js/ui.js', './js/list.js',
  './js/editor.js', './js/calendar.js', './js/gantt.js', './js/resources.js', './js/suggest.js',
  './js/drag.js', './js/outlook.js', './js/notify.js', './js/matrix.js', './js/github.js',
  './vendor/msal-browser.min.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Fichiers de l'application : réseau d'abord (toujours la dernière version, sans mélange de versions),
// copie locale seulement hors connexion. Microsoft et GitHub (données) ne sont jamais mis en cache.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch {
      return (await cache.match(key, { ignoreSearch: req.mode === 'navigate' })) || Response.error();
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#taches', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
