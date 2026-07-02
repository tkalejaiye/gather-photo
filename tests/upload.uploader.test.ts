import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainQueue,
  MAX_ATTEMPTS,
  __resetForTests as resetUploader,
  type TusModule,
  type TusUpload,
  type TusUploadOptions,
  type UploaderDeps,
} from "@/lib/upload/uploader";
import {
  enqueue,
  get,
  getByStatus,
  type EnqueueInput,
  type QueueDB,
  type QueueDeps,
  type UploadItem,
  type UploadStatus,
} from "@/lib/upload/queue";

// FRI-13's real acceptance test lives here. TECH_SPEC §5 calls out the
// integration case explicitly: simulate a mid-upload network drop, then prove
// the upload resumes from the last committed byte instead of restarting.
//
// The whole uploader is built around DI seams so this file never needs a real
// browser, a real Supabase, or a real tus-js-client — we inject:
//   - a fake queue backed by an in-memory Map (same shim used in queue tests)
//   - a fake `TusModule` whose `Upload` streams bytes into a `FakeTusServer`
//     that tracks committed-offset per URL, so a "resume" call HEAD-probes
//     the server and continues from the last committed byte
//   - a fake `fetch` that stands in for /api/uploads/register
//
// If the resume works, `FakeTusServer` will see the file's total bytes
// arrive exactly once — no duplicate re-transfer of the pre-drop bytes.

// ────────────────────────────────────────────────────────────
// Queue shim (same shape as tests/upload.queue.test.ts)
// ────────────────────────────────────────────────────────────

function makeStore(): Map<string, UploadItem> {
  return new Map();
}

function makeShim(store: Map<string, UploadItem>): QueueDB {
  return {
    async put(item) {
      store.set(item.id, { ...item });
    },
    async get(id) {
      const row = store.get(id);
      return row ? { ...row } : undefined;
    },
    async getByStatus(statuses) {
      const set = new Set<UploadStatus>(statuses);
      return [...store.values()].filter((i) => set.has(i.status)).map((i) => ({ ...i }));
    },
    async countByStatus(status) {
      let n = 0;
      for (const i of store.values()) if (i.status === status) n++;
      return n;
    },
    async delete(id) {
      store.delete(id);
    },
    async claim(cap, stamp) {
      let inFlight = 0;
      const queued: UploadItem[] = [];
      for (const item of store.values()) {
        if (item.status === "uploading") inFlight++;
        else if (item.status === "queued") queued.push({ ...item });
      }
      const slots = Math.max(0, cap - inFlight);
      if (slots === 0) return [];
      queued.sort((a, b) => a.createdAt - b.createdAt);
      const claimed: UploadItem[] = [];
      for (const item of queued.slice(0, slots)) {
        const next = stamp(item);
        store.set(next.id, { ...next });
        claimed.push(next);
      }
      return claimed;
    },
    async patch(id, transform) {
      const existing = store.get(id);
      if (!existing) return undefined;
      const next = transform({ ...existing });
      store.set(id, { ...next });
      return next;
    },
  };
}

function queueDeps(store: Map<string, UploadItem>): Partial<QueueDeps> {
  return { open: async () => makeShim(store), now: () => 1_000 };
}

// ────────────────────────────────────────────────────────────
// Fake TUS server + Upload — models the byte-offset-per-URL contract that
// tus-js-client relies on for resume.
// ────────────────────────────────────────────────────────────

interface ServerSlot {
  total: number;
  committed: number;
}

class FakeTusServer {
  private slots = new Map<string, ServerSlot>();
  /** Cumulative bytes seen for a URL across all Upload attempts. Lets tests assert no re-transfer. */
  totalBytesReceived = new Map<string, number>();

  createSlot(url: string, total: number): void {
    this.slots.set(url, { total, committed: 0 });
    if (!this.totalBytesReceived.has(url)) this.totalBytesReceived.set(url, 0);
  }
  committedOffset(url: string): number {
    return this.slots.get(url)?.committed ?? 0;
  }
  receive(url: string, bytes: number): void {
    const slot = this.slots.get(url);
    if (!slot) throw new Error(`FakeTusServer: unknown URL ${url}`);
    slot.committed += bytes;
    this.totalBytesReceived.set(
      url,
      (this.totalBytesReceived.get(url) ?? 0) + bytes,
    );
  }
  isComplete(url: string): boolean {
    const slot = this.slots.get(url);
    return !!slot && slot.committed >= slot.total;
  }
}

interface FakeTusHooks {
  /** Fire onError after this many bytes have been "sent" on the specified URL. Cleared after firing. */
  dropAfterBytes?: number;
  /** URLs already dropped-on this session — set per-run so a resume doesn't re-drop. */
  dropped: Set<string>;
}

function makeFakeTus(server: FakeTusServer, hooks: FakeTusHooks): TusModule {
  let urlCounter = 0;
  class FakeUpload implements TusUpload {
    url: string | null;
    private ended = false;
    constructor(
      private blob: Blob,
      private opts: TusUploadOptions,
    ) {
      // Resume path: caller handed us a URL from IndexedDB.
      this.url = opts.uploadUrl ?? null;
    }
    async start(): Promise<void> {
      // Model the create request (POST) — assigns a new upload URL.
      if (!this.url) {
        urlCounter += 1;
        this.url = `https://fake-tus.local/upload/${urlCounter}`;
        server.createSlot(this.url, this.blob.size);
        this.opts.onUploadUrlAvailable?.();
      } else {
        // Resume: register the URL if we somehow didn't already know it
        // (real tus-js-client HEAD-probes at this point).
        if (!server.committedOffset(this.url) && !hooks.dropped.has(this.url)) {
          // Test bug — a URL we never created is being resumed.
          this.opts.onError(new Error("FakeTusServer: unknown resume URL"));
          return;
        }
        this.opts.onUploadUrlAvailable?.();
      }
      const url = this.url;
      const CHUNK = 1024;
      // Simulate byte-by-byte upload as a sequence of microtasks. Between
      // chunks we let other awaits run, so the queue writes from
      // `onProgress` complete before the next tick.
      while (!this.ended) {
        const start = server.committedOffset(url);
        if (start >= this.blob.size) {
          this.opts.onSuccess();
          return;
        }
        // Trigger a drop if we've crossed the threshold on this URL.
        if (
          hooks.dropAfterBytes !== undefined &&
          !hooks.dropped.has(url) &&
          start >= hooks.dropAfterBytes
        ) {
          hooks.dropped.add(url);
          this.opts.onError(new Error("simulated network drop"));
          return;
        }
        const remaining = this.blob.size - start;
        const step = Math.min(CHUNK, remaining);
        server.receive(url, step);
        this.opts.onProgress(start + step, this.blob.size);
        // Yield so `onProgress`-triggered queue writes settle before the next chunk.
        await Promise.resolve();
      }
    }
    async abort(): Promise<void> {
      this.ended = true;
    }
  }
  return { Upload: FakeUpload };
}

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

function makeBlob(size: number, seed = 0): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i + seed) & 0xff;
  return new Blob([bytes], { type: "image/jpeg" });
}

function makeInput(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    id: crypto.randomUUID(),
    eventSlug: "lagos-wedding-2026",
    uploaderToken: "guest-token-abc",
    uploaderName: "Amaka",
    blob: makeBlob(8_000),
    path: "events/lagos-wedding-2026/1234.jpg",
    contentType: "image/jpeg",
    contentHash: "a".repeat(64),
    bytes: 8_000,
    width: 2048,
    height: 1536,
    ...overrides,
  };
}

function makeDeps(
  store: Map<string, UploadItem>,
  tus: TusModule,
  fetchImpl: UploaderDeps["fetch"],
  overrides: Partial<UploaderDeps> = {},
): Partial<UploaderDeps> {
  return {
    loadTus: async () => tus,
    fetch: fetchImpl,
    tusEndpoint: "https://fake-tus.local/upload",
    registerEndpoint: "/api/uploads/register",
    tusHeaders: {},
    inFlightCap: 1,
    maxAttempts: MAX_ATTEMPTS,
    queue: queueDeps(store),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetUploader();
});
afterEach(() => {
  resetUploader();
  vi.clearAllMocks();
});

describe("drainQueue — happy path", () => {
  it("uploads a queued item, persists the TUS URL, and registers the media row", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock: UploaderDeps["fetch"] = vi.fn(async () =>
      jsonResponse({ mediaId: "m1", duplicate: false }),
    );

    const item = await enqueue(makeInput(), queueDeps(store));

    await drainQueue(makeDeps(store, tus, fetchMock));

    const stored = await get(item.id, queueDeps(store));
    expect(stored?.status).toBe("done");
    expect(stored?.progress).toBe(1);
    expect(stored?.blob).toBeNull(); // freed on markDone
    // URL persisted so a future retry could resume — even after done we don't wipe it.
    expect(stored?.tusUploadUrl).toMatch(/^https:\/\/fake-tus\.local\/upload\//);

    // Register was called exactly once with the right payload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      slug: "lagos-wedding-2026",
      path: "events/lagos-wedding-2026/1234.jpg",
      bytes: 8_000,
      contentHash: "a".repeat(64),
      uploaderToken: "guest-token-abc",
      uploaderName: "Amaka",
      width: 2048,
      height: 1536,
    });
  });
});

describe("drainQueue — resume across a mid-upload network drop (THE FRI-13 acceptance test)", () => {
  it("resumes from the last committed byte after a drop, without re-transferring earlier bytes", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropAfterBytes: 3_000, dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({ mediaId: "m1", duplicate: false }));

    const blob = makeBlob(8_000);
    const item = await enqueue(makeInput({ blob, bytes: 8_000 }), queueDeps(store));

    // First drain: the fake server aborts after ~3 KB with a "network drop".
    await drainQueue(makeDeps(store, tus, fetchMock));

    const midway = await get(item.id, queueDeps(store));
    expect(midway?.status).toBe("failed");
    expect(midway?.lastError).toMatch(/simulated network drop/);
    // Blob still there so a retry has something to send.
    expect(midway?.blob).toBeInstanceOf(Blob);
    // The URL is the single most important thing — without it, a page reload
    // would POST-create a new upload and lose the ~3 KB we already sent.
    const savedUrl = midway?.tusUploadUrl;
    expect(savedUrl).toMatch(/^https:\/\/fake-tus\.local\/upload\//);

    // Server saw ~3 KB from the first attempt. Snapshot the count so the
    // resume assertion isn't fooled by a full re-transfer that happens to
    // sum to 8 KB (the whole point of the test).
    const bytesAfterDrop = server.totalBytesReceived.get(savedUrl!) ?? 0;
    expect(bytesAfterDrop).toBeGreaterThanOrEqual(3_000);
    expect(bytesAfterDrop).toBeLessThan(8_000);

    // Second drain: this models the `online` event firing after the network
    // came back. drainQueue itself promotes the failed row to `queued` before
    // claiming (bounded by maxAttempts), so there's no external nudging —
    // the reconnect trigger alone is enough to resume. The URL stays, and
    // hooks.dropped remembers we already dropped this URL so the fake TUS
    // will let the transfer complete this time.
    await drainQueue(makeDeps(store, tus, fetchMock));

    const final = await get(item.id, queueDeps(store));
    expect(final?.status).toBe("done");
    expect(final?.blob).toBeNull();
    // Same URL — no new POST-create — confirming we actually resumed.
    expect(final?.tusUploadUrl).toBe(savedUrl);

    // The core assertion: total bytes the server received on this URL equals
    // the file size. If we re-transferred the first ~3 KB, this would be
    // ~11 KB. Byte-resume is proven by this line.
    const total = server.totalBytesReceived.get(savedUrl!)!;
    expect(total).toBe(8_000);

    // Register was called exactly once (only on the successful attempt).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("survives a FULL PAGE RELOAD between the drop and the resume", async () => {
    // Same as above, but between the two drains we throw away the uploader
    // module's own state (draining guard) AND rebuild the queue connection —
    // modelling the tab actually closing and re-opening. If we relied on any
    // in-memory tus fingerprint store, this test would fail.
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropAfterBytes: 2_000, dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({ mediaId: "m1", duplicate: false }));

    const item = await enqueue(makeInput({ blob: makeBlob(5_000), bytes: 5_000 }), queueDeps(store));
    await drainQueue(makeDeps(store, tus, fetchMock));

    // Reload: drop draining flag, rebuild the deps from scratch. The queue
    // shim happens to share `store` across sessions, which is exactly what
    // IndexedDB does across a tab reload.
    resetUploader();

    // No hand-flip: the second drainQueue call (as would fire from load or
    // from the `online` event on reopen) is expected to auto-promote the
    // failed row and resume from the persisted TUS URL on its own.
    await drainQueue(makeDeps(store, tus, fetchMock));

    const final = await get(item.id, queueDeps(store));
    expect(final?.status).toBe("done");
    expect(server.totalBytesReceived.get(final!.tusUploadUrl!)).toBe(5_000);
  });
});

describe("drainQueue — no silent failures", () => {
  it("marks the item failed with the error message when tus exhausts retries", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    // dropAfterBytes = 0 and `dropped` starts empty, so every start() will
    // drop before sending anything. Model of "all retries exhausted".
    const hooks: FakeTusHooks = { dropAfterBytes: 0, dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({ mediaId: "m1", duplicate: false }));

    const item = await enqueue(makeInput(), queueDeps(store));
    await drainQueue(makeDeps(store, tus, fetchMock));

    const stored = await get(item.id, queueDeps(store));
    expect(stored?.status).toBe("failed");
    // Error surfaced, not swallowed — TECH_SPEC §8 "no silent upload failures".
    expect(stored?.lastError).toBe("simulated network drop");
    // Register was never called — no phantom media rows.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the item failed when the register endpoint rejects", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    // Upload succeeds but /api/uploads/register returns a 4xx.
    const fetchMock = vi.fn(async () => jsonResponse({ error: "Event not available." }, 404));

    const item = await enqueue(makeInput(), queueDeps(store));
    await drainQueue(makeDeps(store, tus, fetchMock));

    const stored = await get(item.id, queueDeps(store));
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toBe("Event not available.");
  });

  it("stops auto-retrying a poison item once maxAttempts is reached", async () => {
    // A photo that fails every attempt (bad content, oversize, unreadable)
    // must not silently spin on every reconnect forever. After maxAttempts
    // drains, drainQueue leaves it in `failed` for the guest to see / act on.
    const store = makeStore();
    const server = new FakeTusServer();
    // Fresh Set each drain so the fake TUS drops every attempt on every URL.
    const tus = makeFakeTus(server, { dropAfterBytes: 0, dropped: new Set() });
    const fetchMock: UploaderDeps["fetch"] = vi.fn(async () => jsonResponse({}));

    const item = await enqueue(makeInput(), queueDeps(store));
    // Drain repeatedly. Each drain: promote failed→queued, claim (bump
    // attempts), upload, drop, mark failed. After maxAttempts drains the
    // item's attempts hits the cap and further drains skip it.
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      // Fresh dropped set each round — every drain's upload attempt drops.
      const roundTus = makeFakeTus(server, { dropAfterBytes: 0, dropped: new Set() });
      await drainQueue(makeDeps(store, roundTus, fetchMock));
      resetUploader();
    }
    const stored = await get(item.id, queueDeps(store));
    expect(stored?.status).toBe("failed");
    expect(stored?.attempts).toBe(MAX_ATTEMPTS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the item failed when /api/uploads/register throws (network error)", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const item = await enqueue(makeInput(), queueDeps(store));
    await drainQueue(makeDeps(store, tus, fetchMock));

    const stored = await get(item.id, queueDeps(store));
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toBe("fetch failed");
  });
});

describe("drainQueue — concurrency + emptiness", () => {
  it("is a no-op when the queue is empty", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({}));

    await drainQueue(makeDeps(store, tus, fetchMock));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.totalBytesReceived.size).toBe(0);
  });

  it("only one drain runs at a time — concurrent calls are dedup'd", async () => {
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({ mediaId: "m1", duplicate: false }));

    await enqueue(makeInput({ blob: makeBlob(2_000), bytes: 2_000 }), queueDeps(store));
    await enqueue(makeInput({ blob: makeBlob(2_000), bytes: 2_000 }), queueDeps(store));

    const deps = makeDeps(store, tus, fetchMock);
    // Fire two drainers at once (load + `online` colliding). The `draining`
    // guard should make the second one a no-op; the first should drain the
    // whole queue on its own thanks to the inner claim-loop.
    await Promise.all([drainQueue(deps), drainQueue(deps)]);

    const done = await getByStatus(["done"], queueDeps(store));
    expect(done).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drains multiple items over successive claim rounds under cap=1", async () => {
    // Sanity check on the loop-claim: with cap=1 and three items queued, a
    // single drainQueue call should still finish all three.
    const store = makeStore();
    const server = new FakeTusServer();
    const hooks: FakeTusHooks = { dropped: new Set() };
    const tus = makeFakeTus(server, hooks);
    const fetchMock = vi.fn(async () => jsonResponse({ mediaId: "m1", duplicate: false }));

    for (let i = 0; i < 3; i++) {
      await enqueue(makeInput({ blob: makeBlob(1_000), bytes: 1_000 }), queueDeps(store));
    }

    await drainQueue(makeDeps(store, tus, fetchMock));

    expect((await getByStatus(["done"], queueDeps(store))).length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
