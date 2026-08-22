/*
 * Service worker: makes the app work with no connection at all.
 *
 * Cache-first is the right strategy here and not merely a shortcut. The app is
 * a fixed set of files that never needs anything from the network at runtime,
 * so serving from cache is both faster and a demonstration of the promise --
 * once the page is open it can do its whole job with the network switched off.
 *
 * Bump CACHE when any file changes; the old cache is deleted on activate.
 */
const CACHE = "msp-v13";
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest", "./icon.svg",
  "./icon-192.png", "./icon-512.png",
  "./assets/app.css", "./assets/app.js", "./assets/rules.js",
  "./assets/parse.js", "./assets/crypto.js", "./assets/xls.js",
  "./assets/pdfread.js", "./assets/analyse.js", "./assets/charts.js",
  "./assets/demo.js", "./assets/share.js", "./assets/feedback.js",
];

/*
 * Fetch every asset with cache: "reload", which is the whole point of this
 * function existing rather than a bare addAll().
 *
 * addAll() fetches normally, and a normal fetch is allowed to come out of the
 * browser's ordinary HTTP cache. The site sends Cache-Control for seven days
 * on JavaScript, so a brand-new service worker with a brand-new cache name
 * would dutifully fill it with the *old* files -- and the app would look
 * unchanged for a week, on exactly the devices that had visited before.
 *
 * That is not a hypothetical. It is what made a phone keep showing the old
 * behaviour while a desktop that had never cached the files showed the new
 * one, and it wasted an afternoon looking for a mobile bug that did not exist.
 * "reload" forces each request past the HTTP cache to the server.
 */
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ASSETS.map(u =>
      fetch(new Request(u, { cache: "reload" }))
        .then(r => (r.ok ? c.put(u, r) : null))
        .catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // Cache same-origin successes so a first visit primes the cache for the
      // next one. Anything else is passed through untouched.
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
