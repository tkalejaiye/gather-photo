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
// The handshake repeats as lazily-imported chunks load, and re-fetches the
// shell once it is older than SHELL_TTL_MS so the offline copy cannot drift
// arbitrarily far behind the deployed build.
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

// How long a warmed shell is trusted before `warm()` refetches it. Without
// this the shell is banked once and never refreshed inside a VERSION, so a
// guest who opened the roll on invite day and returns to the venue several
// deploys later would run arbitrarily old JS offline (the matching chunks are
// still in ASSET_CACHE, so it would even be self-consistent). Online is always
// network-first and therefore always current; this bounds the OFFLINE copy.
const SHELL_TTL_MS = 6 * 60 * 60 * 1000;

// Bounds on one warm burst. The list arrives by postMessage and the guest is
// on the congested network this feature exists to survive, so warming is
// capped and near-serial: TECH_SPEC §8/§10 keep uploads at an in-flight cap of
// 1 because parallel streams stall on iOS Safari, and this must not quietly
// reintroduce concurrency on the same connection pool.
const MAX_WARM_ASSETS = 60;
const WARM_CONCURRENCY = 2;

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
    // A shell for an event whose upload window has closed is worse than no
    // shell: the guest gets a working picker, shoots into the queue, and every
    // register 404s on reconnect (lib/upload/server.ts). Let the browser show
    // its offline page instead.
    if (cached && !isClosed(cached)) return cached;
    // Nothing usable banked for this slug — let the browser show its offline
    // page rather than inventing a fake shell with no working upload UI.
    throw err;
  }
}

/** True once the event's upload window (stamped at warm time) has passed. */
function isClosed(response) {
  const closeAt = response.headers.get("x-gather-close-at");
  if (!closeAt) return false;
  const at = Date.parse(closeAt);
  return Number.isFinite(at) && Date.now() > at;
}

/** True when there is no warmed shell, or the one we have is past its TTL. */
function isStale(response) {
  if (!response) return true;
  const warmed = Number(response.headers.get("x-gather-warmed"));
  return !Number.isFinite(warmed) || Date.now() - warmed > SHELL_TTL_MS;
}

/**
 * Re-wrap a response with the two stamps `networkFirst` reads back. Responses
 * carry no metadata of their own, and Cache Storage has nowhere else to put
 * it, so it rides in headers on the stored copy.
 */
async function stamp(response, closeAt) {
  const headers = new Headers(response.headers);
  headers.set("x-gather-warmed", String(Date.now()));
  if (typeof closeAt === "string" && closeAt) headers.set("x-gather-close-at", closeAt);
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Cache what the guest page tells us it needs to come back from the dead.
 * Fills gaps only: once warm and inside the TTL this does no network work at
 * all, which matters because the guest is on the congested network we are
 * trying to survive.
 */
async function warm(shellUrl, assets, closeAt) {
  if (typeof shellUrl !== "string") return;
  let url;
  try {
    url = new URL(shellUrl, self.location.origin);
  } catch {
    return;
  }
  // Trust nothing from postMessage: same-origin guest routes only.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/e/")) return;

  const shell = await caches.open(SHELL_CACHE);
  const key = shellKey(url);
  if (isStale(await shell.match(key))) {
    // `credentials` so a PIN-gated event returns the unlocked page the guest
    // is actually looking at, not the PIN prompt.
    const response = await fetch(key, { credentials: "same-origin" }).catch(() => null);
    // `redirected` responses throw when handed back to a navigation later.
    if (response && response.ok && response.type === "basic" && !response.redirected) {
      // Quota is shared with the IndexedDB photo queue — a failed put must
      // never break anything, it just means no offline shell this time.
      await shell.put(key, await stamp(response, closeAt)).catch(() => undefined);
    }
  }

  const assetCache = await caches.open(ASSET_CACHE);
  const wanted = [];
  for (const href of Array.isArray(assets) ? assets : []) {
    if (typeof href !== "string") continue;
    let asset;
    try {
      asset = new URL(href, self.location.origin);
    } catch {
      continue;
    }
    if (asset.origin !== self.location.origin || !isHashedAsset(asset)) continue;
    wanted.push(asset.href);
    if (wanted.length >= MAX_WARM_ASSETS) break;
  }
  await warmAssets(assetCache, wanted);
}

/** Fetch missing assets a couple at a time — never a burst (see the caps). */
async function warmAssets(cache, urls) {
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const href = urls[next];
      next += 1;
      if (await cache.match(href)) continue;
      // Best-effort per asset: one miss (or a full quota) must not sink the rest.
      await cache.add(href).catch(() => undefined);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WARM_CONCURRENCY, urls.length) }, worker),
  );
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "gather-warm-shell") return;
  event.waitUntil(warm(data.url, data.assets, data.closeAt));
});

/** Cache-first for content-hashed assets — the URL changes when bytes do. */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === "basic") {
    // Never let a cache write break the request. Cache Storage shares the
    // origin quota with the IndexedDB photo queue, so the guest most likely to
    // hit QuotaExceededError is the one with the most photos queued — exactly
    // the guest whose page must not break.
    await cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}
