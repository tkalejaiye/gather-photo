import { describe, it, expect } from "vitest";
import {
  DEFAULT_IN_FLIGHT_CAP,
  claimNext,
  countByStatus,
  enqueue,
  get,
  getByStatus,
  markDone,
  markFailed,
  remove,
  requeue,
  setProgress,
  type EnqueueInput,
  type QueueDB,
  type QueueDeps,
  type UploadItem,
  type UploadStatus,
} from "@/lib/upload/queue";

// vitest environment is `node` (see vitest.config.ts), which has no real
// IndexedDB. Following the compress.ts DI pattern, we inject an in-memory shim
// over a Map — that lets us prove queue behavior (persistence across a
// simulated reload, durable transitions, in-flight cap) without pulling in a
// browser polyfill or standing up a real IDB.

/**
 * In-memory backing store shared across "sessions" — represents the on-disk
 * IndexedDB. Each `open()` returns a fresh shim over the same Map, which is
 * how we simulate a tab reload: same underlying storage, brand-new connection.
 */
function makeStore(): Map<string, UploadItem> {
  return new Map();
}

function makeShim(store: Map<string, UploadItem>): QueueDB {
  return {
    async put(item) {
      // Structured-clone-ish copy so tests can't accidentally mutate stored rows.
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
      // Match the IDB `readwrite` transaction semantics: run the whole
      // count → list → write cycle without yielding to other microtasks.
      // Since Map access is synchronous and this method never awaits, two
      // concurrent callers will observe each other's writes — the concurrency
      // test below relies on this to prove the cap is actually respected.
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
      // Same shape as `claim`: never yields internally, so two concurrent
      // patchers on the same id serialize in JS-turn order — matching the
      // IDB single-transaction semantics.
      const existing = store.get(id);
      if (!existing) return undefined;
      const next = transform({ ...existing });
      store.set(id, { ...next });
      return next;
    },
  };
}

/** Build deps whose `open()` always returns a shim over the same store. */
function depsFor(store: Map<string, UploadItem>, clock = () => 1_000): Partial<QueueDeps> {
  return {
    open: async () => makeShim(store),
    now: clock,
  };
}

function makeBlob(bytes = 32, byte = 5): Blob {
  return new Blob([new Uint8Array(bytes).fill(byte)], { type: "image/jpeg" });
}

function makeInput(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    id: crypto.randomUUID(),
    eventSlug: "lagos-wedding-2026",
    uploaderToken: "guest-token-abc",
    uploaderName: "Amaka",
    blob: makeBlob(),
    path: "events/lagos-wedding-2026/1234.jpg",
    contentType: "image/jpeg",
    contentHash: "a".repeat(64),
    bytes: 32,
    width: 2048,
    height: 1536,
    ...overrides,
  };
}

describe("enqueue", () => {
  it("stamps status/progress/attempts/timestamps and persists the item", async () => {
    const store = makeStore();
    const deps = depsFor(store, () => 42);
    const item = await enqueue(makeInput(), deps);

    expect(item.status).toBe("queued");
    expect(item.progress).toBe(0);
    expect(item.attempts).toBe(0);
    expect(item.createdAt).toBe(42);
    expect(item.updatedAt).toBe(42);
    expect(store.get(item.id)?.blob).toBeInstanceOf(Blob);
  });

  it("stores the compressed blob (not a URL/ref) so reads survive a tab reload", async () => {
    const store = makeStore();
    const blob = makeBlob(128, 7);
    const item = await enqueue(makeInput({ blob }), depsFor(store));

    // A fresh open() = simulated reload: no in-memory shim state carried over.
    const reloaded = await get(item.id, depsFor(store));
    expect(reloaded?.blob).toBeInstanceOf(Blob);
    expect(reloaded?.blob?.size).toBe(128);
  });
});

describe("persistence across a simulated reload", () => {
  it("returns queued items after the connection is thrown away", async () => {
    const store = makeStore();

    // Session 1: enqueue two items, then discard the connection (tab close).
    const a = await enqueue(makeInput(), depsFor(store));
    const b = await enqueue(makeInput(), depsFor(store));

    // Session 2: fresh open() over the same underlying store.
    const queued = await getByStatus(["queued"], depsFor(store));
    const ids = queued.map((i) => i.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("keeps mid-upload progress durable across a reload", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    await claimNext(1, depsFor(store));
    await setProgress(item.id, 0.42, depsFor(store));

    // Reload: the last written progress must still be there.
    const reloaded = await get(item.id, depsFor(store));
    expect(reloaded?.status).toBe("uploading");
    expect(reloaded?.progress).toBe(0.42);
  });
});

describe("status transitions are durable", () => {
  it("claimNext flips queued → uploading and bumps attempts once", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    const [claimed] = await claimNext(1, depsFor(store));
    expect(claimed.status).toBe("uploading");
    expect(claimed.attempts).toBe(1);

    // A subsequent retry cycle bumps attempts again — no double-counting from
    // some other "start uploading" path.
    await markFailed(item.id, "net", depsFor(store));
    await requeue(item.id, depsFor(store));
    const [again] = await claimNext(1, depsFor(store));
    expect(again.attempts).toBe(2);
  });

  it("markFailed records the error and keeps the blob for a retry", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    await claimNext(1, depsFor(store));
    await markFailed(item.id, "network dropped", depsFor(store));

    const reloaded = await get(item.id, depsFor(store));
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.lastError).toBe("network dropped");
    // Bytes stay so drainQueue can pick it up again.
    expect(reloaded?.blob).toBeInstanceOf(Blob);
  });

  it("requeue moves a failed item back to queued and clears the error", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    await claimNext(1, depsFor(store));
    await markFailed(item.id, "boom", depsFor(store));
    await requeue(item.id, depsFor(store));

    const reloaded = await get(item.id, depsFor(store));
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.progress).toBe(0);
    expect(reloaded?.lastError).toBeUndefined();
  });

  it("requeue refuses to resurrect a done item whose blob is gone", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    await markDone(item.id, depsFor(store));
    await requeue(item.id, depsFor(store));

    const reloaded = await get(item.id, depsFor(store));
    // Would spin forever without bytes, so it stays done.
    expect(reloaded?.status).toBe("done");
    expect(reloaded?.blob).toBeNull();
  });

  it("updatedAt advances on every mutation", async () => {
    const store = makeStore();
    let t = 100;
    const clock = () => t;
    const item = await enqueue(makeInput(), depsFor(store, clock));
    expect(item.updatedAt).toBe(100);

    t = 200;
    await claimNext(1, depsFor(store, clock));
    expect((await get(item.id, depsFor(store, clock)))?.updatedAt).toBe(200);

    t = 300;
    await setProgress(item.id, 0.5, depsFor(store, clock));
    expect((await get(item.id, depsFor(store, clock)))?.updatedAt).toBe(300);
  });
});

describe("query-by-status", () => {
  it("returns only items matching the requested statuses", async () => {
    const store = makeStore();
    const a = await enqueue(makeInput(), depsFor(store));
    const b = await enqueue(makeInput(), depsFor(store));
    const c = await enqueue(makeInput(), depsFor(store));

    // Drive to end state: a queued, b uploading, c failed.
    await claimNext(3, depsFor(store));          // all three → uploading
    await markFailed(c.id, "boom", depsFor(store)); // c → failed
    await requeue(a.id, depsFor(store));          // a → queued (blob still present)

    const queued = await getByStatus(["queued"], depsFor(store));
    const uploading = await getByStatus(["uploading"], depsFor(store));
    const failed = await getByStatus(["failed"], depsFor(store));
    const retryable = await getByStatus(["queued", "failed"], depsFor(store));

    expect(queued.map((i) => i.id)).toEqual([a.id]);
    expect(uploading.map((i) => i.id)).toEqual([b.id]);
    expect(failed.map((i) => i.id)).toEqual([c.id]);
    expect(retryable.map((i) => i.id).sort()).toEqual([a.id, c.id].sort());
  });

  it("countByStatus matches getByStatus", async () => {
    const store = makeStore();
    await enqueue(makeInput(), depsFor(store));
    await enqueue(makeInput(), depsFor(store));
    await claimNext(1, depsFor(store));

    expect(await countByStatus("queued", depsFor(store))).toBe(1);
    expect(await countByStatus("uploading", depsFor(store))).toBe(1);
    expect(await countByStatus("done", depsFor(store))).toBe(0);
  });
});

describe("markDone / removal / blob freeing", () => {
  it("markDone releases the blob but keeps the row durable", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput({ blob: makeBlob(4096) }), depsFor(store));
    await claimNext(1, depsFor(store));
    await markDone(item.id, depsFor(store));

    const reloaded = await get(item.id, depsFor(store));
    expect(reloaded?.status).toBe("done");
    expect(reloaded?.progress).toBe(1);
    // Blob freed — critical on cheap phones (TECH_SPEC §10).
    expect(reloaded?.blob).toBeNull();
  });

  it("remove() deletes the row entirely", async () => {
    const store = makeStore();
    const item = await enqueue(makeInput(), depsFor(store));
    await remove(item.id, depsFor(store));
    expect(await get(item.id, depsFor(store))).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("in-flight cap (claimNext)", () => {
  it("has a sensible default that prevents storage blowout on cheap phones", () => {
    // Sanity check the exported constant — if this ever ticks up we want the
    // reviewer to think about how many compressed images a Transsion device
    // can realistically buffer in RAM at once.
    expect(DEFAULT_IN_FLIGHT_CAP).toBeLessThanOrEqual(4);
    expect(DEFAULT_IN_FLIGHT_CAP).toBeGreaterThanOrEqual(1);
  });

  it("claims at most `cap` items and flips them to 'uploading'", async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) await enqueue(makeInput(), depsFor(store));

    const claimed = await claimNext(2, depsFor(store));
    expect(claimed).toHaveLength(2);
    expect(claimed.every((i) => i.status === "uploading")).toBe(true);
    expect(await countByStatus("uploading", depsFor(store))).toBe(2);
    expect(await countByStatus("queued", depsFor(store))).toBe(3);
  });

  it("respects items already in-flight (does not exceed cap globally)", async () => {
    const store = makeStore();
    await enqueue(makeInput(), depsFor(store));
    await enqueue(makeInput(), depsFor(store));
    await enqueue(makeInput(), depsFor(store));

    // First claim takes 1 into 'uploading'.
    await claimNext(1, depsFor(store));
    expect(await countByStatus("uploading", depsFor(store))).toBe(1);

    // Cap = 2, one slot left → second call claims exactly one more.
    const claimed = await claimNext(2, depsFor(store));
    expect(claimed).toHaveLength(1);
    expect(await countByStatus("uploading", depsFor(store))).toBe(2);
  });

  it("returns nothing when already at cap", async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) await enqueue(makeInput(), depsFor(store));
    await claimNext(2, depsFor(store));

    expect(await claimNext(2, depsFor(store))).toEqual([]);
    expect(await countByStatus("queued", depsFor(store))).toBe(1);
  });

  it("claims oldest-first so guests don't watch new shots preempt older ones", async () => {
    const store = makeStore();
    let t = 0;
    const clock = () => t++;
    const first = await enqueue(makeInput(), depsFor(store, clock));
    const second = await enqueue(makeInput(), depsFor(store, clock));
    const third = await enqueue(makeInput(), depsFor(store, clock));

    const claimed = await claimNext(2, depsFor(store, clock));
    expect(claimed.map((i) => i.id)).toEqual([first.id, second.id]);
    expect((await get(third.id, depsFor(store, clock)))?.status).toBe("queued");
  });

  it("two concurrent claims never exceed the cap (atomicity)", async () => {
    // The spec-reviewer flagged that a naive read-then-write claim would let
    // two drainers (initial load + `online` event) both observe 0 in-flight
    // and double-claim. The IDB backend runs claim inside a readwrite
    // transaction; the test shim mirrors that by keeping the whole
    // count-list-write cycle synchronous. This test proves that even under
    // interleaved async calls, the cap holds and no item is claimed twice.
    const store = makeStore();
    for (let i = 0; i < 10; i++) await enqueue(makeInput(), depsFor(store));

    const [a, b] = await Promise.all([
      claimNext(3, depsFor(store)),
      claimNext(3, depsFor(store)),
    ]);
    const claimedIds = [...a, ...b].map((i) => i.id);
    const unique = new Set(claimedIds);

    // No row appears in both result sets.
    expect(unique.size).toBe(claimedIds.length);
    // Cap of 3 is respected across both callers.
    expect(await countByStatus("uploading", depsFor(store))).toBe(3);
  });
});
