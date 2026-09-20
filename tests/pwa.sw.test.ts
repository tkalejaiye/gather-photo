// FRI-21 — the routing decisions of public/sw.js.
//
// The property under test is the BYPASS: for upload traffic the worker must
// not call `event.respondWith` at all, so the browser performs the request
// natively. If a future edit makes the worker respond to a TUS PATCH, it
// re-issues a 6 MB body from worker context and re-opens the iOS Safari
// "stuck at 0%" failure that FRI-25/FRI-32 fixed (TECH_SPEC §10).
//
// public/sw.js is not a module — it's a classic worker script that registers
// listeners on `self`. We evaluate it inside a node:vm context with a fake
// ServiceWorkerGlobalScope and then drive the captured listeners directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, beforeEach } from "vitest";

const SW_SOURCE = readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://gather.photo";

type Listeners = Record<string, (event: unknown) => void>;

type FakeCache = {
  put: (req: unknown, res: unknown) => Promise<void>;
  add: (url: string) => Promise<void>;
  match: (req: unknown) => Promise<unknown>;
  entries: Map<string, unknown>;
};

function loadWorker(
  options: {
    cacheNames?: string[];
    offline?: boolean;
    quotaExceeded?: boolean;
    redirected?: boolean;
  } = {},
) {
  const listeners: Listeners = {};
  const caches_ = new Map<string, FakeCache>();
  const deletedCaches: string[] = [];
  const fetched: string[] = [];

  function openCache(name: string): Promise<FakeCache> {
    let cache = caches_.get(name);
    if (!cache) {
      const entries = new Map<string, unknown>();
      cache = {
        entries,
        async put(req: unknown, res: unknown) {
          if (options.quotaExceeded) throw new Error("QuotaExceededError");
          const key = String((req as { url?: string }).url ?? req);
          entries.set(new URL(key, ORIGIN).href, res);
        },
        async add(url: string) {
          if (options.offline) throw new TypeError("Failed to fetch");
          if (options.quotaExceeded) throw new Error("QuotaExceededError");
          fetched.push(url);
          // The real Cache API keys by ABSOLUTE url, including for relative
          // `add()` arguments — mirror that so a key mismatch between `add()`
          // and `cacheFirst`'s `match(request)` would fail here too.
          entries.set(new URL(url, ORIGIN).href, { ok: true, added: true });
        },
        async match(req: unknown) {
          const key = String((req as { url?: string }).url ?? req);
          return entries.get(new URL(key, ORIGIN).href);
        },
      };
      caches_.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      skipWaiting: () => undefined,
      clients: { claim: () => Promise.resolve() },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = fn;
      },
    },
    caches: {
      open: openCache,
      keys: () => Promise.resolve(options.cacheNames ?? []),
      delete: (name: string) => {
        deletedCaches.push(name);
        return Promise.resolve(true);
      },
    },
    fetch: (req: string | { url: string }) => {
      fetched.push(typeof req === "string" ? req : req.url);
      // `offline` models a dead venue network: the browser rejects the fetch.
      if (options.offline) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        type: "basic",
        redirected: options.redirected === true,
        headers: new Headers(),
        blob: async () => new Blob(["<html>shell</html>"]),
        clone: () => ({ body: "copy" }),
      });
    },
    URL,
    Headers,
    Response,
    Promise,
    Date,
    Number,
    Array,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  const worker_ = {
    listeners,
    caches_,
    deletedCaches,
    fetched,
    /** Seed a cache entry the way a previous visit's `warm()` would have.
     *  `stamps` mirrors the headers `warm()` writes onto the stored shell. */
    async seed(
      cacheName: string,
      key: string,
      value: Record<string, unknown>,
      stamps: Record<string, string> = { "x-gather-warmed": String(Date.now()) },
    ) {
      const cache = await openCache(cacheName);
      cache.entries.set(new URL(key, ORIGIN).href, {
        ...value,
        headers: new Headers(stamps),
      });
    },
    /** Deliver a postMessage to the worker and await its waitUntil. */
    async postMessage(data: unknown) {
      let waited: Promise<unknown> | null = null;
      worker_.listeners.message({
        data,
        waitUntil(p: Promise<unknown>) {
          waited = p;
        },
      });
      await waited;
    },
  };
  return worker_;
}

/** Drive the fetch listener and report whether the worker claimed the request. */
async function dispatchFetch(
  worker: ReturnType<typeof loadWorker>,
  url: string,
  init: { method?: string; mode?: string } = {},
) {
  let responded: unknown = null;
  let claimed = false;
  const request = { url, method: init.method ?? "GET", mode: init.mode ?? "no-cors" };
  worker.listeners.fetch({
    request,
    respondWith(value: unknown) {
      claimed = true;
      responded = value;
    },
  });
  if (!responded) return { claimed, response: null };
  try {
    return { claimed, response: await responded };
  } catch (err) {
    return { claimed, response: err };
  }
}

describe("service worker — bypass (the upload path must never touch the worker)", () => {
  let worker: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    worker = loadWorker();
  });

  it("bypasses the Supabase TUS endpoint entirely (cross-origin)", async () => {
    const tus = "https://abcdef.supabase.co/storage/v1/upload/resumable/some-id";
    for (const method of ["POST", "PATCH", "HEAD", "GET"]) {
      const { claimed } = await dispatchFetch(worker, tus, { method });
      expect(claimed, `${method} to the TUS endpoint must not be handled`).toBe(false);
    }
    expect(worker.fetched).toEqual([]);
  });

  it("bypasses every non-GET request, same-origin included", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const { claimed } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1`, {
        method,
        mode: "navigate",
      });
      expect(claimed, `${method} must not be handled`).toBe(false);
    }
  });

  it("bypasses /api/* (upload registration, moderation, ZIP stream)", async () => {
    for (const p of [
      "/api/uploads/register",
      "/api/events/abc/media",
      "/api/events/abc/download",
    ]) {
      const { claimed } = await dispatchFetch(worker, `${ORIGIN}${p}`);
      expect(claimed, `${p} must not be handled`).toBe(false);
    }
  });

  it("bypasses its own script and RSC flight requests", async () => {
    expect((await dispatchFetch(worker, `${ORIGIN}/sw.js`)).claimed).toBe(false);
    expect(
      (await dispatchFetch(worker, `${ORIGIN}/e/roll-1?_rsc=1a2b3`, { mode: "navigate" })).claimed,
    ).toBe(false);
  });

  it("leaves host-dashboard navigations to the browser (no authenticated HTML cached)", async () => {
    for (const p of ["/dashboard", "/dashboard/events/abc", "/sign-in", "/"]) {
      const { claimed } = await dispatchFetch(worker, `${ORIGIN}${p}`, { mode: "navigate" });
      expect(claimed, `${p} must not be handled`).toBe(false);
    }
    expect(worker.caches_.get("gather-shell-v1")).toBeUndefined();
  });
});

describe("service worker — the guest shell", () => {
  const SHELL = "gather-shell-v1";
  const ASSETS = "gather-assets-v1";

  it("serves /e/{slug} from the network when the network is up, and does not cache it", async () => {
    const worker = loadWorker();
    const { claimed } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1`, { mode: "navigate" });
    expect(claimed).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.fetched).toEqual([`${ORIGIN}/e/roll-1`]);
    // Writes to the shell cache happen only in warm() — see sw.js header.
    expect(worker.caches_.get(SHELL)).toBeUndefined();
  });

  it("warms the shell + assets on the first visit, since that navigation was never intercepted", async () => {
    const worker = loadWorker();
    await worker.postMessage({
      type: "gather-warm-shell",
      url: `${ORIGIN}/e/roll-1`,
      assets: [
        `${ORIGIN}/_next/static/chunks/main-abc.js`,
        `${ORIGIN}/_next/static/css/app-def.css`,
      ],
    });
    expect(worker.caches_.get(SHELL)?.entries.has(`${ORIGIN}/e/roll-1`)).toBe(true);
    expect([...(worker.caches_.get(ASSETS)?.entries.keys() ?? [])].sort()).toEqual([
      `${ORIGIN}/_next/static/chunks/main-abc.js`,
      `${ORIGIN}/_next/static/css/app-def.css`,
    ]);
  });

  it("does no network work when everything is already warm (the congested-network case)", async () => {
    const worker = loadWorker();
    const asset = `${ORIGIN}/_next/static/chunks/main-abc.js`;
    await worker.seed(SHELL, `${ORIGIN}/e/roll-1`, { ok: true });
    await worker.seed(ASSETS, asset, { ok: true });
    await worker.postMessage({
      type: "gather-warm-shell",
      url: `${ORIGIN}/e/roll-1`,
      assets: [asset],
    });
    expect(worker.fetched).toEqual([]);
  });

  it("drops the query string when warming, so a ?error= render is never the shell", async () => {
    const worker = loadWorker();
    await worker.postMessage({
      type: "gather-warm-shell",
      url: `${ORIGIN}/e/roll-1?error=Wrong+PIN`,
      assets: [],
    });
    expect(worker.fetched).toEqual([`${ORIGIN}/e/roll-1`]);
    expect([...(worker.caches_.get(SHELL)?.entries.keys() ?? [])]).toEqual([
      `${ORIGIN}/e/roll-1`,
    ]);
  });

  it("ignores warm messages for anything that isn't a same-origin guest route", async () => {
    const worker = loadWorker();
    for (const url of [
      `${ORIGIN}/dashboard`,
      "https://evil.example/e/roll-1",
      `${ORIGIN}/`,
    ]) {
      await worker.postMessage({ type: "gather-warm-shell", url, assets: [] });
    }
    // And non-hashed assets are refused even on a valid warm.
    await worker.postMessage({
      type: "gather-warm-shell",
      url: `${ORIGIN}/e/roll-1`,
      assets: [`${ORIGIN}/api/events/abc/download`, "https://evil.example/x.js"],
    });
    expect(worker.fetched).toEqual([`${ORIGIN}/e/roll-1`]);
  });

  it("falls back to the warmed shell when the network is down", async () => {
    const worker = loadWorker({ offline: true });
    await worker.seed(SHELL, `${ORIGIN}/e/roll-1`, { ok: true, cached: true });
    const { claimed, response } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1`, {
      mode: "navigate",
    });
    expect(claimed).toBe(true);
    // The whole point of the issue: a dead network still yields a shell.
    expect(response).toMatchObject({ ok: true, cached: true });
  });

  it("serves the warmed shell for a slug reopened with a query string", async () => {
    const worker = loadWorker({ offline: true });
    await worker.seed(SHELL, `${ORIGIN}/e/roll-1`, { ok: true, cached: true });
    const { response } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1?from=qr`, {
      mode: "navigate",
    });
    expect(response).toMatchObject({ ok: true, cached: true });
  });

  it("propagates the network error when nothing is cached (no blank fake shell)", async () => {
    const worker = loadWorker({ offline: true });
    const { claimed, response } = await dispatchFetch(worker, `${ORIGIN}/e/never-seen`, {
      mode: "navigate",
    });
    expect(claimed).toBe(true);
    expect(response).toBeInstanceOf(TypeError);
  });

  it("caches hashed static assets cache-first", async () => {
    const worker = loadWorker();
    const url = `${ORIGIN}/_next/static/chunks/main-abc123.js`;
    const { claimed } = await dispatchFetch(worker, url);
    expect(claimed).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.caches_.get(ASSETS)?.entries.has(url)).toBe(true);
  });

  it("serves a hashed asset from cache without hitting the network", async () => {
    const worker = loadWorker({ offline: true });
    const url = `${ORIGIN}/_next/static/chunks/main-abc123.js`;
    await worker.seed(ASSETS, url, { ok: true, cached: true });
    const { response } = await dispatchFetch(worker, url);
    expect(response).toMatchObject({ ok: true, cached: true });
    expect(worker.fetched).toEqual([]);
  });
});

describe("service worker — surviving a full storage quota and a closed event", () => {
  const SHELL = "gather-shell-v1";
  const ASSETS = "gather-assets-v1";

  it("still serves an asset when the cache write fails (quota shared with the photo queue)", async () => {
    // The guest most likely to hit QuotaExceededError is the one with the most
    // photos queued in IndexedDB — exactly the guest whose page must not break.
    const worker = loadWorker({ quotaExceeded: true });
    const url = `${ORIGIN}/_next/static/chunks/main-abc123.js`;
    const { claimed, response } = await dispatchFetch(worker, url);
    expect(claimed).toBe(true);
    expect(response).toMatchObject({ ok: true, status: 200 });
    expect(response).not.toBeInstanceOf(Error);
  });

  it("does not blow up warming when the quota is exhausted", async () => {
    const worker = loadWorker({ quotaExceeded: true });
    await expect(
      worker.postMessage({
        type: "gather-warm-shell",
        url: `${ORIGIN}/e/roll-1`,
        assets: [`${ORIGIN}/_next/static/chunks/main-abc.js`],
      }),
    ).resolves.not.toThrow();
  });

  it("refuses to serve a shell whose event has closed", async () => {
    // A working picker for a closed event means the guest shoots into a queue
    // whose every register will 404 on reconnect (lib/upload/server.ts).
    const worker = loadWorker({ offline: true });
    await worker.seed(
      SHELL,
      `${ORIGIN}/e/roll-1`,
      { ok: true, cached: true },
      {
        "x-gather-warmed": String(Date.now()),
        "x-gather-close-at": new Date(Date.now() - 60_000).toISOString(),
      },
    );
    const { response } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1`, { mode: "navigate" });
    expect(response).toBeInstanceOf(TypeError);
  });

  it("still serves a shell whose event is open", async () => {
    const worker = loadWorker({ offline: true });
    await worker.seed(
      SHELL,
      `${ORIGIN}/e/roll-1`,
      { ok: true, cached: true },
      {
        "x-gather-warmed": String(Date.now()),
        "x-gather-close-at": new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    const { response } = await dispatchFetch(worker, `${ORIGIN}/e/roll-1`, { mode: "navigate" });
    expect(response).toMatchObject({ ok: true, cached: true });
  });

  it("re-warms a shell that is past its TTL, so the offline copy can't drift across deploys", async () => {
    const worker = loadWorker();
    await worker.seed(SHELL, `${ORIGIN}/e/roll-1`, { ok: true }, {
      "x-gather-warmed": String(Date.now() - 7 * 60 * 60 * 1000),
    });
    await worker.postMessage({ type: "gather-warm-shell", url: `${ORIGIN}/e/roll-1`, assets: [] });
    expect(worker.fetched).toEqual([`${ORIGIN}/e/roll-1`]);
  });

  it("refuses to bank a redirected response as the shell", async () => {
    // A redirected response throws when handed back to a navigation later.
    const worker = loadWorker({ redirected: true });
    await worker.postMessage({ type: "gather-warm-shell", url: `${ORIGIN}/e/roll-1`, assets: [] });
    expect(worker.caches_.get(SHELL)?.entries.size ?? 0).toBe(0);
  });

  it("caps one warm burst and ignores junk in the message", async () => {
    const worker = loadWorker();
    const many = Array.from(
      { length: 200 },
      (_, i) => `${ORIGIN}/_next/static/chunks/c${i}.js`,
    );
    await worker.postMessage({
      type: "gather-warm-shell",
      url: `${ORIGIN}/e/roll-1`,
      assets: [...many, null, 42, "::::not a url::::"],
    });
    const assetFetches = worker.fetched.filter((u) => u.includes("/_next/static/"));
    expect(assetFetches.length).toBe(60);
    expect(worker.caches_.get(ASSETS)?.entries.size).toBe(60);
  });

  it("ignores a message with a non-string url instead of rejecting", async () => {
    const worker = loadWorker();
    await expect(
      worker.postMessage({ type: "gather-warm-shell", url: { evil: true }, assets: [] }),
    ).resolves.not.toThrow();
    expect(worker.fetched).toEqual([]);
  });
});

describe("service worker — cache lifecycle", () => {
  it("deletes its own stale caches on activate and leaves others alone", async () => {
    const worker = loadWorker({
      cacheNames: ["gather-shell-v0", "gather-assets-v0", "gather-shell-v1", "some-other-cache"],
    });
    let waited: Promise<unknown> | null = null;
    worker.listeners.activate({
      waitUntil(p: Promise<unknown>) {
        waited = p;
      },
    });
    await waited;
    expect(worker.deletedCaches.sort()).toEqual(["gather-assets-v0", "gather-shell-v0"]);
  });

  it("precaches the manifest and icons on install", async () => {
    const worker = loadWorker();
    let waited: Promise<unknown> | null = null;
    worker.listeners.install({
      waitUntil(p: Promise<unknown>) {
        waited = p;
      },
    });
    await waited;
    const assets = worker.caches_.get("gather-assets-v1");
    expect([...(assets?.entries.keys() ?? [])].sort()).toEqual([
      `${ORIGIN}/icon-192.png`,
      `${ORIGIN}/icon-512.png`,
      `${ORIGIN}/manifest.webmanifest`,
    ]);
  });
});
