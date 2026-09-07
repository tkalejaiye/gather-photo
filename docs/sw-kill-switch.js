/*
 * KILL SWITCH for the gather.photo service worker (FRI-21).
 *
 * DO NOT edit public/sw.js down to nothing and hope. A worker already
 * installed on a guest's phone keeps running until a NEW worker at the same
 * URL replaces it, so the only way to disable it is to ship a worker whose
 * job is to remove itself.
 *
 * To disable the offline shell in production:
 *   cp docs/sw-kill-switch.js public/sw.js   (keep the /sw.js path — that is
 *                                             the URL installed clients poll)
 *   deploy
 *
 * What happens on each guest's phone: the browser checks /sw.js on the next
 * navigation, sees different bytes, installs THIS worker, which deletes every
 * cache the old worker owned, unregisters itself, and reloads any open tab so
 * the guest is immediately on the live network path. Afterwards the page is a
 * plain website again. /sw.js is served `max-age=0, must-revalidate`
 * (next.config.mjs) so the update check is never blocked by an HTTP cache.
 *
 * Leave this file in place for at least one event cycle before deleting
 * public/sw.js outright — deleting it makes /sw.js 404, and a 404 on the
 * worker script also unregisters, but only in newer browsers.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith("gather-")).map((name) => caches.delete(name)),
      );
      await self.registration.unregister();
      // Best-effort reload of open tabs onto the live network path. iOS Safari
      // before 16.4 has no client.navigate() and throws; unregister() has
      // already happened by this point, so the switch has done its job either
      // way — the guest just sees the change on their next navigation.
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) client.navigate(client.url);
      } catch {
        // ignore — see above
      }
    })(),
  );
});

// No fetch handler at all: every request goes straight to the network.
