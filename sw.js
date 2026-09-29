const CACHE_NAME = 'livro-caixa-v1.7.0';
const APP_SHELL = [
  './index.html',
  './app.js',
  './secure-vault.js',
  './secure-ui.js',
  './secure-ui.css',
  './financ-icons.js',
  './fonts/fonts.css',
  './fonts/ibm-plex-mono-latin-400.woff2',
  './fonts/ibm-plex-mono-latin-500.woff2',
  './fonts/ibm-plex-mono-latin-600.woff2',
  './fonts/ibm-plex-mono-latin-ext-400.woff2',
  './fonts/ibm-plex-mono-latin-ext-500.woff2',
  './fonts/ibm-plex-mono-latin-ext-600.woff2',
  './fonts/space-grotesk-latin-ext.woff2',
  './fonts/space-grotesk-latin.woff2',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('SW: falhou ao cachear', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Rede primeiro: atualizações valem na hora; o cache só entra quando estiver offline.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && event.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
