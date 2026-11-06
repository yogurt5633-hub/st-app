// Keeps the app shell offline so the icon opens even while SillyTavern is stopped.
// API calls always go to the network.
const VERSION = 'korrektor-0.4.22';
const SHELL = [
    './',
    'index.html',
    'style.css',
    'app.js',
    'tools.js',
    'theme.js',
    'diff.js',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/icon-192.png',
    'img/sleep.png',
    'img/confused.png',
    'img/light/sleep.png',
    'img/light/confused.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('korrektor-') && k !== VERSION).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin) return;
    const scope = new URL(self.registration.scope);
    if (!url.pathname.startsWith(scope.pathname)) return;
    // Network first, so updates arrive at once; cache when SillyTavern is down.
    event.respondWith(fetch(event.request)
        .then(response => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(VERSION).then(cache => cache.put(event.request, copy));
            }
            return response;
        })
        .catch(() => caches.match(event.request).then(hit => hit || caches.match('index.html'))));
});
