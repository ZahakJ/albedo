// albedo service worker. Generated into dist/sw.js at build time
// (vite.config.js), which fills in the version and the precache list.
const SHELL = 'albedo-shell-__VERSION__'
const MODELS = 'albedo-models'
const PRECACHE = __PRECACHE__

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith('albedo-shell-') && k !== SHELL)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

// shell: cache first (hashed names never change content); navigations fall
// back to the cached document; models: cached the first time they load
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./', { cacheName: SHELL })))
    return
  }
  const isModel = url.pathname.includes('/models/')
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? fetch(req).then((res) => {
    if (res.ok && isModel) {
      const copy = res.clone()
      caches.open(MODELS).then((c) => c.put(req, copy))
    }
    return res
  })))
})
