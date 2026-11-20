/**
 * Service worker for a Gina bundle — basic cache-first strategy.
 *
 * Starting point only: it pre-caches a small app shell on install and serves
 * cached responses first, falling back to the network. Edit CACHE_NAME and
 * PRECACHE_URLS for your app, and extend the fetch strategy as needed
 * (network-first for APIs, stale-while-revalidate for assets, ...).
 *
 * Registered by the default layout (templates/html/layouts/main.html). Served
 * at /sw.js: a service worker's scope is the directory it is served from, so
 * keeping it at the public root gives it whole-origin scope.
 */

'use strict';

/**
 * Cache bucket name. Bump the version suffix whenever the precache list or any
 * cached asset changes — the activate handler purges every other bucket.
 *
 * @constant {string}
 */
var CACHE_NAME = 'gina-bundle-cache-v1';

/**
 * App-shell URLs pre-cached at install time. Keep this list short — just the
 * entry points needed to render the first screen offline.
 *
 * @constant {string[]}
 */
var PRECACHE_URLS = [
    '/',
    '/manifest.webmanifest'
];

/**
 * Install handler — opens the cache bucket, pre-caches the app shell, then
 * activates this worker immediately instead of waiting for open clients to
 * close.
 *
 * @param {ExtendableEvent} event - The service worker `install` event.
 * @returns {void}
 *
 * @example
 * // Fired automatically by the browser after registration.
 */
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(PRECACHE_URLS);
        })
    );
    self.skipWaiting();
});

/**
 * Activate handler — purges cache buckets left over from previous versions,
 * then takes control of open clients without waiting for a reload.
 *
 * @param {ExtendableEvent} event - The service worker `activate` event.
 * @returns {void}
 *
 * @example
 * // Fired automatically by the browser once the new worker takes over.
 */
self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) {
                return (key === CACHE_NAME) ? null : caches.delete(key);
            }));
        })
    );
    self.clients.claim();
});

/**
 * Fetch handler — cache-first. Returns the cached response when one exists,
 * otherwise fetches from the network and caches a copy of successful
 * same-origin GET responses for next time. When the network is unreachable
 * and nothing is cached, navigations fall back to the precached app shell.
 *
 * @param {FetchEvent} event - The service worker `fetch` event.
 * @returns {void}
 *
 * @example
 * // Fired automatically by the browser for every same-scope request.
 */
self.addEventListener('fetch', function (event) {
    // Only GET requests are cacheable — let the browser handle the rest.
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(function (cached) {
            if (cached) {
                return cached;
            }

            return fetch(event.request).then(function (response) {
                // Only cache valid, basic (same-origin) responses.
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }

                var copy = response.clone();
                caches.open(CACHE_NAME).then(function (cache) {
                    cache.put(event.request, copy);
                });

                return response;
            }).catch(function () {
                // Offline with no cached copy — fall back to the precached app
                // shell for navigations so the page still renders; other
                // requests surface the network error as they normally would.
                if (event.request.mode === 'navigate') {
                    return caches.match('/');
                }
            });
        })
    );
});
