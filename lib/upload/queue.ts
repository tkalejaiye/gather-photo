// Durable upload queue backed by IndexedDB.
//
// This is the offline half of the "survive a congested venue network" contract
// (TECH_SPEC §5, §10): guests capture, we enqueue the compressed blob + its
// metadata, and every state transition is written to IndexedDB so a tab close,
// browser crash, or dropped connection mid-upload doesn't lose their photos.
// The uploader (FRI-13/14) reads from and mutates this queue.
//
// Design notes:
//   - Blob is stored directly in IndexedDB (structured clone), not as a URL.
//     Object URLs die with the tab; the blob itself persists.
//   - `blob` is set to null once `status === 'done'` so cheap phones aren't
//     holding a full event's worth of compressed images in local storage.
//   - `idb` is dynamically imported so it never lands in the guest's initial
//     bundle (TECH_SPEC §8: `/e/[slug]` First Load JS ≤ 110 kB).
//   - Every exported function accepts a `Partial<QueueDeps>` seam so the module
//     is unit-testable in the node vitest environment (matches lib/image/compress.ts).

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

export interface UploadItem {
  id: string;
  eventSlug: string;
  uploaderToken: string;
  uploaderName?: string;
  /** Compressed image bytes. Set to null once the item reaches 'done'. */
  blob: Blob | null;
  /** Target storage object name assigned server-side. */
  path: string;
  contentType: string;
  contentHash: string;
  bytes: number;
  width?: number;
  height?: number;
  status: UploadStatus;
  /** 0..1 — TUS progress last reported by the uploader. */
  progress: number;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage-agnostic view of the underlying object store. Every method is a
 * single durable read/write — no in-memory state that would be lost across
 * a tab reload. The default implementation is an IndexedDB shim; tests inject
 * an in-memory shim over a Map to prove behavior in node.
 */
export interface QueueDB {
  put(item: UploadItem): Promise<void>;
  get(id: string): Promise<UploadItem | undefined>;
  getByStatus(statuses: UploadStatus[]): Promise<UploadItem[]>;
  countByStatus(status: UploadStatus): Promise<number>;
  delete(id: string): Promise<void>;
  /**
   * Atomically claim up to `cap - currentInFlight` queued items, stamping each
   * via `stamp` before writing it back. The IDB implementation runs the whole
   * thing inside a single `readwrite` transaction so two concurrent drainers
   * can't observe the same "0 in-flight" state and double-claim the same rows.
   * Returns the transitioned items (already in the target status).
   */
  claim(cap: number, stamp: (item: UploadItem) => UploadItem): Promise<UploadItem[]>;
}

export interface QueueDeps {
  /** Open (or return a cached handle to) the backing store. */
  open: () => Promise<QueueDB>;
  /** Injectable clock so tests don't depend on wall time. */
  now: () => number;
}

/**
 * Default cap on concurrent 'uploading' items. Low enough that a cheap phone
 * with a saturated uplink doesn't buffer many chunks in memory at once
 * (TECH_SPEC §10: cap in-flight queue size).
 */
export const DEFAULT_IN_FLIGHT_CAP = 3;

const DB_NAME = "gather-photo";
const VERSION = 1;
const STORE = "uploads";
const STATUS_INDEX = "byStatus";

let cachedDb: Promise<QueueDB> | null = null;

async function defaultOpen(): Promise<QueueDB> {
  if (cachedDb) return cachedDb;
  cachedDb = (async (): Promise<QueueDB> => {
    // Dynamic import: `idb` must not land in the initial guest chunk.
    const { openDB } = await import("idb");
    const db = await openDB(DB_NAME, VERSION, {
      upgrade(d) {
        const store = d.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex(STATUS_INDEX, "status");
      },
    });
    return {
      async put(item) {
        await db.put(STORE, item);
      },
      async get(id) {
        return (await db.get(STORE, id)) as UploadItem | undefined;
      },
      async getByStatus(statuses) {
        const buckets = await Promise.all(
          statuses.map((s) => db.getAllFromIndex(STORE, STATUS_INDEX, s) as Promise<UploadItem[]>),
        );
        return buckets.flat();
      },
      async countByStatus(status) {
        return db.countFromIndex(STORE, STATUS_INDEX, status);
      },
      async delete(id) {
        await db.delete(STORE, id);
      },
      async claim(cap, stamp) {
        // Single readwrite transaction: count in-flight, list queued, and
        // write the claimed rows back without ever releasing the store lock.
        // Two concurrent drainers serialize here instead of racing.
        const tx = db.transaction(STORE, "readwrite");
        const index = tx.store.index(STATUS_INDEX);
        const inFlight = await index.count("uploading");
        const slots = Math.max(0, cap - inFlight);
        if (slots === 0) {
          await tx.done;
          return [];
        }
        const queued = ((await index.getAll("queued")) as UploadItem[]).sort(
          (a, b) => a.createdAt - b.createdAt,
        );
        const claimed: UploadItem[] = [];
        for (const item of queued.slice(0, slots)) {
          const next = stamp(item);
          await tx.store.put(next);
          claimed.push(next);
        }
        await tx.done;
        return claimed;
      },
    };
  })();
  return cachedDb;
}

const defaultDeps: QueueDeps = {
  open: defaultOpen,
  now: () => Date.now(),
};

/** Fields the caller supplies; the queue stamps status/progress/timestamps. */
export type EnqueueInput = Omit<
  UploadItem,
  "status" | "progress" | "attempts" | "createdAt" | "updatedAt" | "lastError"
>;

/** Add a compressed blob + metadata to the queue. Persists immediately. */
export async function enqueue(
  input: EnqueueInput,
  overrides: Partial<QueueDeps> = {},
): Promise<UploadItem> {
  const { open, now } = { ...defaultDeps, ...overrides };
  const db = await open();
  const t = now();
  const item: UploadItem = {
    ...input,
    status: "queued",
    progress: 0,
    attempts: 0,
    createdAt: t,
    updatedAt: t,
  };
  await db.put(item);
  return item;
}

export async function get(
  id: string,
  overrides: Partial<QueueDeps> = {},
): Promise<UploadItem | undefined> {
  const { open } = { ...defaultDeps, ...overrides };
  return (await open()).get(id);
}

export async function getByStatus(
  statuses: UploadStatus[],
  overrides: Partial<QueueDeps> = {},
): Promise<UploadItem[]> {
  const { open } = { ...defaultDeps, ...overrides };
  return (await open()).getByStatus(statuses);
}

export async function countByStatus(
  status: UploadStatus,
  overrides: Partial<QueueDeps> = {},
): Promise<number> {
  const { open } = { ...defaultDeps, ...overrides };
  return (await open()).countByStatus(status);
}

/** Durable progress write — persists so a reload can render mid-upload state. */
export async function setProgress(
  id: string,
  progress: number,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  await mutate(id, overrides, (existing) => ({ ...existing, progress }));
}

/**
 * Terminal success: mark done, pin progress at 1, and FREE the blob.
 * Freeing the blob is what keeps the on-device queue from growing without
 * bound as the guest keeps shooting (TECH_SPEC §10).
 */
export async function markDone(
  id: string,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  await mutate(id, overrides, (existing) => ({
    ...existing,
    status: "done",
    progress: 1,
    blob: null,
  }));
}

/** Terminal failure — keep the blob so the uploader can retry on next drain. */
export async function markFailed(
  id: string,
  error?: string,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  await mutate(id, overrides, (existing) => ({
    ...existing,
    status: "failed",
    lastError: error,
  }));
}

/** Move a failed item back to 'queued' so a fresh drain will pick it up. */
export async function requeue(
  id: string,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  await mutate(id, overrides, (existing) => {
    // Without bytes we can't upload, so a requeue would spin forever.
    if (existing.blob === null) return existing;
    return { ...existing, status: "queued", progress: 0, lastError: undefined };
  });
}

export async function remove(
  id: string,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  const { open } = { ...defaultDeps, ...overrides };
  await (await open()).delete(id);
}

/**
 * Atomically claim the next batch of queued items to upload, honoring an
 * in-flight cap on 'uploading' items. The transition (queued → uploading +
 * attempts bump) happens inside a single IDB `readwrite` transaction, so two
 * concurrent drainers can't both observe "0 in-flight" and double-claim the
 * same rows. This is the ONLY sanctioned way to start an upload — callers
 * must not flip items to 'uploading' by hand, since that would bypass the cap.
 *
 * @param cap  Max total items allowed in 'uploading' after this call returns.
 * @returns    The items that were transitioned to 'uploading' this round.
 */
export async function claimNext(
  cap: number = DEFAULT_IN_FLIGHT_CAP,
  overrides: Partial<QueueDeps> = {},
): Promise<UploadItem[]> {
  const { open, now } = { ...defaultDeps, ...overrides };
  const db = await open();
  return db.claim(cap, (item) => ({
    ...item,
    status: "uploading",
    attempts: item.attempts + 1,
    updatedAt: now(),
  }));
}

async function mutate(
  id: string,
  overrides: Partial<QueueDeps>,
  transform: (existing: UploadItem) => UploadItem,
): Promise<UploadItem | undefined> {
  const { open, now } = { ...defaultDeps, ...overrides };
  const db = await open();
  const existing = await db.get(id);
  if (!existing) return undefined;
  const next = { ...transform(existing), updatedAt: now() };
  await db.put(next);
  return next;
}

/** Test hook: drops the module-level connection cache. */
export function __resetForTests(): void {
  cachedDb = null;
}
