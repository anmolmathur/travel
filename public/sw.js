// Wander service worker: keeps the app and your latest logbook on this device, so tickets open on a train or a
// plane with no signal. Network first (deploys still apply at once), but a slow network falls back to the saved copy.
const CACHE = "wander-v1";
const SHELL = ["/", "/app.js", "/app.css", "/globe.js", "/lib/core.js", "/lib/rail.js", "/vendor/d3.min.js", "/vendor/topojson-client.min.js",
  "/data/ref.json", "/data/countries-110m.json", "/data/countries-50m.json", "/favicon.svg", "/manifest.webmanifest"];
// Data worth having offline. AI, lookups, exports and every write stay network-only.
const DATA = /^\/api\/(me|flights|people|trips)$/;

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/mcp")) return;
  const isData = url.pathname.startsWith("/api/");
  if (isData && !DATA.test(url.pathname)) return;
  e.respondWith(networkFirst(req, isData));
});

async function networkFirst(req, isData) {
  const cache = await caches.open(CACHE);
  const key = req.mode === "navigate" ? "/" : req;
  const net = fetch(req).then(async res => {
    if (res.ok) {
      if (isData) {
        const headers = new Headers(res.headers); headers.set("x-wander-saved", new Date().toISOString());
        await cache.put(key, new Response(await res.clone().arrayBuffer(), { status: 200, headers }));
      } else await cache.put(key, res.clone());
    }
    return res;
  });
  try {
    return await Promise.race([net, new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), isData ? 6000 : 3500))]);
  } catch {
    const hit = await cache.match(key);
    if (!hit) return net.catch(() => Response.error());
    if (!isData) return hit;
    const headers = new Headers(hit.headers); headers.set("x-wander-offline", "1");
    return new Response(await hit.arrayBuffer(), { status: 200, headers });
  }
}

// Signing out clears the saved copy.
self.addEventListener("message", e => { if (e.data === "clear") e.waitUntil(caches.delete(CACHE)); });
