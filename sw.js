'use strict';

const CACHE_PREFIX = 'top-static-';
const CACHE_NAME = CACHE_PREFIX + '20261026-v4';
const ROOT_URL = new URL('./', self.location.href).href;
const INDEX_URL = new URL('index.html', ROOT_URL).href;
const STATIC_URLS = [
  'index.html', 'styles.css', 'app.js', 'ui.js', 'memory-curve.js', 'data/words.json',
  'manifest.json', 'favicon.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'assets/mascot.svg', 'assets/mascot-icon.svg',
  'install.html', 'assets/install.css', 'THIRD_PARTY_NOTICES.txt'
].map(path => new URL(path, ROOT_URL).href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_URLS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  url.search = '';
  url.hash = '';
  const key = url.href === ROOT_URL ? INDEX_URL : url.href;
  if (!STATIC_URLS.includes(key)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request, { cache: 'no-cache' });
      if (response.ok) await cache.put(key, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
