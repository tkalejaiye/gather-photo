/*
 * gather.photo service worker — offline shell for the guest route (FRI-21).
 *
 * Why this exists: a guest standing on a saturated venue network whose page
 * won't load walks away, and the photos already sitting in their IndexedDB
 * queue never upload. An OPEN PAGE is what drains that queue (the `online`
 * listener in lib/upload/uploader.ts lives in the page, not here). So the one
 * job of this worker is: make /e/{slug} open when the network is down.
 *
 * Hand-written on purpose — no next-pwa / Workbox. The /e/[slug] First Load
 * JS budget is 110 kB (TECH_SPEC §8) and this file is not part of the page
 * bundle at all; it must stay small enough to read in one sitting.
 *
 * THE MOST IMPORTANT PROPERTY OF THIS FILE IS WHAT IT DOES *NOT* HANDLE.
 * `fetch` fires for every request the page makes, including the TUS XHRs
 * carrying photo bytes to Supabase Storage. For anything upload-related we
 * return without calling `event.respondWith` at all, so the browser performs
 * the request natively. Re-issuing a 6 MB PATCH body from worker context
 * re-opens the WebKit failure class that FRI-25/FRI-32 fixed ("stuck at 0%"
 * on iOS Safari). See `shouldBypass` below — that function is the safety
 * property of this worker; treat changes to it as changes to the upload path.
 *
 * Deliberately NOT here:
 *   - Install / add-to-homescreen promotion. A guest uses this once for
 *     twenty minutes at a wedding. The manifest is valid; we don't nag.
 *   - Background Sync. lib/upload/uploader.ts registers a "gather-photo-drain"
 *     tag and this worker leaves it unhandled on purpose: running the upload
 *     engine in worker context is a large change with no iOS support, and
 *     it waits until the field test says how often guests abandon mid-upload.
 */

// HOW THE SHELL GETS CACHED (read this before changing the fetch handler):
// NOT from the fetch handler. A page that loads with no controller stays
// uncontrolled for that navigation — `clients.claim()` only affects later
// fetches — so on a guest's FIRST visit the HTML and the first-load chunks are
// already on the wire before this worker exists. Caching navigations
// opportunistically would leave the shell cache empty exactly when it matters
// (scan QR → pick photos → network dies → reload → offline error page).
// Instead the guest page hands us the work explicitly: once it is controlled it
// posts a `gather-warm-shell` message naming itself and the /_next/static/
// assets it actually loaded, and `warm()` below fetches whatever is missing.
//
// That handshake is also what keeps the WRONG page from becoming the shell.
// components/pwa/register-service-worker.tsx renders only on the unlocked,
// still-open branch of app/e/[slug]/page.tsx, so the PIN prompt, the "wrong
// PIN" error render, and the "event has ended" page never post the message and
// can never be served offline in place of the upload page. The fetch handler
// only ever READS the shell cache.
//
// Bump this to invalidate every cache this worker owns. `activate` deletes
// any cache whose name isn't in CURRENT_CACHES, so a version bump is a full
// reset for already-installed clients.
const VERSION = "v1";
const SHELL_CACHE = `gather-shell-${VERSION}`;
const ASSET_CACHE = `gather-assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

// App-level files worth having before the first offline load. Deliberately
// tiny: the hashed JS/CSS chunks are unknowable at author time and get picked
// up at runtime by the cache-first asset path below.
const PRECACHE_URLS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  // A guest who reloads on a dead network should get the NEW worker's
  // behaviour immediately rather than waiting for every tab to close.
  self.skipWaiting();
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) =>
      // Best-effort: one 404 must not fail the whole install.
      Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined)),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("gather-") && !CURRENT_CACHES.includes(name))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Requests this worker must not touch. Returning `true` here means the fetch
 * handler returns without calling `event.respondWith`, which hands the
 * request back to the browser's native networking — no worker in the path,
 * no request body re-issued, no behaviour change of any kind.
 *
 * Bypassed:
 *   - every non-GET request (TUS POST/PATCH/HEAD, form posts, server actions)
 *   - every cross-origin request (Supabase Storage / TUS lives on
 *     *.supabase.co, so this is the primary upload bypass)
 *   - /api/* (upload registration, moderation, ZIP download — all dynamic,
 *     several are large streams, none are useful offline)
 *   - the worker's own script and any Next.js RSC/data fetch, which must
 *     always be live
 */
function shouldBypass(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname === "/sw.js") return true;
  // App Router flight requests (client-side navigations, server action
  // responses). Serving a stale RSC payload is the same failure as a stale
  // shell, and they're never needed offline.
  if (url.searchParams.has("_rsc")) return true;
  return false;
}

/** Build-hashed immutable assets: safe to serve cache-first. */
function isHashedAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

/** Small same-origin app files we precache and are happy to serve offline. */
function isPrecachedAsset(url) {
  return PRECACHE_URLS.includes(url.pathname);
}

/** The guest route — the only navigation we take responsibility for. */
function isGuestNavigation(request, url) {
  return request.mode === "navigate" && url.pathname.startsWith("/e/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ---- the bypass. Nothing below this line runs for upload traffic. ----
  if (shouldBypass(request, url)) return;

  if (isGuestNavigation(request, url)) {
    event.respondWith(networkFirst(request, url));
    return;
  }

  if (isHashedAsset(url) || isPrecachedAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (host dashboard navigations, sign-in, /) is left to the
  // browser. We don't want authenticated HTML sitting in a shared cache, and
  // the offline requirement is about the guest route only.
});

/** Cache key for a guest shell: origin + pathname, query deliberately dropped.
 *  `/e/{slug}?error=Wrong+PIN` and `/e/{slug}` are the same page to a guest
 *  coming back offline, and only the canonical one is ever cached. */
function shellKey(url) {
  return url.origin + url.pathname;
}

/**
 * NETWORK-FIRST, cache as fallback, and READ-ONLY against the shell cache
 * (see the header comment — writes happen in `warm()`).
 *
 * Never cache-first for HTML: a stale shell served to every guest at an event
 * is the worst failure this app has — it would pin a whole venue to an old
 * bundle with no way to push a fix.
 */
async function networkFirst(request, url) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(shellKey(url));
    if (cached) return cached;
    // Nothing banked for this slug — let the browser show its offline page
    // rather than inventing a fake shell with no working upload UI.
    throw err;
  }
}

/**
 * Cache what the guest page tells us it needs to come back from the dead.
 * Only fills gaps: on every visit after the first this does no network work
 * at all, which matters because the guest is on the congested network we are
 * trying to survive.
 */
async function warm(shellUrl, assets) {
  const url = new URL(shellUrl, self.location.origin);
  // Trust nothing from postMessage: same-origin guest routes only.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/e/")) return;

  const shell = await caches.open(SHELL_CACHE);
  const key = shellKey(url);
  if (!(await shell.match(key))) {
    // `credentials` so a PIN-gated event returns the unlocked page the guest
    // is actually looking at, not the PIN prompt.
    const response = await fetch(key, { credentials: "same-origin" });
    if (response && response.ok && response.type === "basic") {
      await shell.put(key, response);
    }
  }

  const assetCache = await caches.open(ASSET_CACHE);
  await Promise.all(
    (assets || []).map(async (href) => {
      const asset = new URL(href, self.location.origin);
      if (asset.origin !== self.location.origin || !isHashedAsset(asset)) return;
      if (await assetCache.match(asset.href)) return;
      // Best-effort per asset: one miss must not sink the rest.
      await assetCache.add(asset.href).catch(() => undefined);
    }),
  );
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "gather-warm-shell") return;
  event.waitUntil(warm(data.url, data.assets));
});

/** Cache-first for content-hashed assets — the URL changes when bytes do. */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}
