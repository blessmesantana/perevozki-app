const CACHE_NAME = 'peredachkin-offline-v1';
const LOCAL_APP_SHELL_PATHS = [
    './',
    './index.html',
    './styles.css',
    './main.js',
    './firebase.js',
    './firebase-service.js',
    './offline-store.js',
    './logger.js',
    './camera.js',
    './scanner.js',
    './ui.js',
    './couriers.js',
    './deliveries.js',
    './admin-panel.js',
    './encyclopedia.js',
    './whats-new.js',
    './new-badges.js',
    './telemetry-config.js',
    './shk-svg-data.js',
    './manifest.webmanifest',
    './app-icon.svg',
    './app-icon-dark.svg',
    './app-icon-light.svg',
];
const REMOTE_APP_SHELL_URLS = [
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js',
    'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
];

function isCacheableRequest(requestUrl) {
    const url = new URL(requestUrl);

    return (
        url.origin === self.location.origin
        || REMOTE_APP_SHELL_URLS.includes(url.toString())
    );
}

async function cacheOptionalUrls(cache, urls) {
    await Promise.allSettled(
        urls.map(async (url) => {
            const response = await fetch(url, {
                cache: 'no-cache',
                mode: 'cors',
            });

            if (response.ok || response.type === 'opaque') {
                await cache.put(url, response.clone());
            }
        }),
    );
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const localUrls = LOCAL_APP_SHELL_PATHS.map((path) => (
            new URL(path, self.location.origin).toString()
        ));

        await cache.addAll(localUrls);
        await cacheOptionalUrls(cache, REMOTE_APP_SHELL_URLS);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();

        await Promise.all(
            cacheNames
                .filter((cacheName) => cacheName !== CACHE_NAME)
                .map((cacheName) => caches.delete(cacheName)),
        );

        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET' || !isCacheableRequest(request.url)) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const networkResponse = await fetch(request);
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, networkResponse.clone());
                return networkResponse;
            } catch (error) {
                const cache = await caches.open(CACHE_NAME);
                return (
                    await cache.match(request)
                    || await cache.match(new URL('./index.html', self.location.origin).toString())
                );
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse = await cache.match(request);

        if (cachedResponse) {
            void fetch(request)
                .then(async (networkResponse) => {
                    if (networkResponse.ok || networkResponse.type === 'opaque') {
                        await cache.put(request, networkResponse.clone());
                    }
                })
                .catch(() => {});

            return cachedResponse;
        }

        try {
            const networkResponse = await fetch(request);

            if (networkResponse.ok || networkResponse.type === 'opaque') {
                await cache.put(request, networkResponse.clone());
            }

            return networkResponse;
        } catch (error) {
            return cache.match(request);
        }
    })());
});
