// Resumable TUS uploader — the "critical path" of the whole product
// (TECH_SPEC §5). Drains the IndexedDB queue, streams each blob to Supabase
// Storage via tus-js-client with exponential backoff, and — most importantly
// for a saturated venue Wi-Fi — resumes an interrupted upload from the last
// committed byte on the next reconnect OR after a full page reload.
//
// The magic that makes reload-resume work is `queue.tusUploadUrl`. When
// tus-js-client hands us a Location on the create response, we persist it on
// the queue row; the next drain reads it back and passes it to tus.Upload as
// `uploadUrl`, which triggers a HEAD to the location and picks up exactly
// where we left off. There is no in-memory fingerprint store — everything
// lives in the queue's IndexedDB row so it survives a full tab close.
//
// Design (mirrors lib/image/compress.ts, lib/upload/queue.ts):
//   - Every entry point takes a `Partial<UploaderDeps>` seam. Tests inject a
//     fake tus client + fake fetch so the resumable-upload flow is exercised
//     in the vitest `node` env without any browser primitives.
//   - `tus-js-client` and `idb` (via the queue module) are dynamically
//     imported so they never enter the initial guest chunk
//     (TECH_SPEC §8 — 110 kB budget on `/e/[slug]`).

import {
  claimNext,
  DEFAULT_IN_FLIGHT_CAP,
  getByStatus,
  markDone,
  markFailed,
  requeue,
  setProgress,
  setTusUploadUrl,
  type QueueDeps,
  type UploadItem,
} from "./queue";

/**
 * Backoff schedule handed to tus-js-client's retry loop. The first value is 0
 * (immediate first retry), then 1s, 3s, 8s, 20s. Total ≈ 32s of wait before we
 * give up and surface a "failed" state to the guest — long enough to ride out
 * a venue Wi-Fi hiccup, short enough that the guest sees a clear failure UI
 * instead of a spinner (TECH_SPEC §8: "no silent upload failures").
 */
export const RETRY_DELAYS: number[] = [0, 1000, 3000, 8000, 20000];

/**
 * Cap on how many times a single item can be flipped back from `failed` to
 * `queued` across drain cycles. Once an item has burned through this many
 * attempts we stop auto-retrying it — the guest still sees a failed row
 * they can manually retry (or delete) so nothing dies silently. Bounds the
 * per-reconnect retry cost on a broken photo (bad content, oversize, etc.).
 */
export const MAX_ATTEMPTS = 5;

/** Supabase requires a fixed 6MB chunk size on its TUS endpoint. */
const CHUNK_SIZE = 6 * 1024 * 1024;

/** Storage bucket name — matches supabase/migrations/0002_storage.sql. */
const BUCKET = "event-media";

/**
 * Subset of `tus.Upload`'s constructor options that the uploader actually
 * wires up. Declared locally so tests can build a fake `Upload` class without
 * depending on tus-js-client's typings.
 */
export interface TusUploadOptions {
  endpoint: string;
  chunkSize: number;
  retryDelays: number[];
  metadata: Record<string, string>;
  /** When set, tus-js-client resumes from this location instead of POST-ing a new one. */
  uploadUrl?: string;
  headers?: Record<string, string>;
  onProgress: (bytesUploaded: number, bytesTotal: number) => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
  /** Fired every time tus receives a new URL for the upload (create + resume). */
  onUploadUrlAvailable?: () => void;
}

/**
 * Shape of the `tus.Upload` instance we need. Kept minimal so the fake in
 * tests is a two-method class.
 */
export interface TusUpload {
  /** Present after the create request (or immediately when resuming from `uploadUrl`). */
  url: string | null;
  start(): void;
  abort(): Promise<void>;
}

export interface TusModule {
  Upload: new (blob: Blob, opts: TusUploadOptions) => TusUpload;
}

export interface UploaderDeps {
  /** Injected in tests; production dynamically imports `tus-js-client`. */
  loadTus: () => Promise<TusModule>;
  /** Injected in tests so we can assert the register call without real HTTP. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** TUS endpoint on Supabase Storage. */
  tusEndpoint: string;
  /** Route that inserts the media row after a successful storage upload. */
  registerEndpoint: string;
  /** Extra headers for the TUS create/PATCH requests (e.g. `Authorization`). */
  tusHeaders: Record<string, string>;
  /** Cap on concurrent uploads — surfaces the queue's in-flight cap here. */
  inFlightCap: number;
  /** Max failed→queued promotions per item before we stop auto-retrying it. */
  maxAttempts: number;
  /** Passed through to every queue call so tests can inject an in-memory shim. */
  queue: Partial<QueueDeps>;
}

async function defaultLoadTus(): Promise<TusModule> {
  // Dynamic import: `tus-js-client` is ~40 kB gz and MUST NOT enter the
  // initial guest chunk (TECH_SPEC §8). It only lands the first time the
  // guest actually triggers a drain.
  const mod = await import("tus-js-client");
  return { Upload: mod.Upload };
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/**
 * Headers Supabase's TUS endpoint expects for anon-scoped writes to a private
 * bucket (see supabase/migrations/0003_storage_rls.sql):
 *   - `authorization` + `apikey` carry the public anon key; RLS on
 *     `storage.objects` gates the actual write to `events/{event_id}/...`
 *     under an active, unexpired event.
 *   - `x-upsert: true` lets a resumed upload PATCH an existing chunk row
 *     without 409-ing on "already exists" — the resume path relies on this.
 * Only assembled when the anon key is present so tests that leave the env
 * unset still get an empty header set (matches the old default of `{}`).
 */
function defaultTusHeaders(): Record<string, string> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) return {};
  return {
    authorization: `Bearer ${anonKey}`,
    apikey: anonKey,
    "x-upsert": "true",
  };
}

const defaultDeps: UploaderDeps = {
  loadTus: defaultLoadTus,
  fetch: defaultFetch,
  tusEndpoint: process.env.NEXT_PUBLIC_SUPABASE_TUS_ENDPOINT ?? "",
  registerEndpoint: "/api/uploads/register",
  tusHeaders: defaultTusHeaders(),
  inFlightCap: DEFAULT_IN_FLIGHT_CAP,
  maxAttempts: MAX_ATTEMPTS,
  queue: {},
};

let draining = false;

/**
 * Drain the queue: claim as many items as the in-flight cap allows, upload
 * each via TUS (resuming from `tusUploadUrl` when present), register on
 * success, and record any failure so the guest sees a clear error state.
 *
 * Idempotent: a re-entrant call while a drain is in flight is a no-op. Safe
 * to call from `load`, from an `online` listener, and from a Background Sync
 * event — whichever fires first wins, and the other returns immediately.
 */
export async function drainQueue(overrides: Partial<UploaderDeps> = {}): Promise<void> {
  if (draining) return;
  // navigator.onLine only exists in the browser; when it's present and false
  // we bail early — the `online` listener will re-trigger us on reconnect.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  draining = true;
  try {
    const deps = { ...defaultDeps, ...overrides };
    // Promote failed + stranded items back to `queued` so this drain retries them.
    //   - `failed`: exhausted tus-js-client's per-connection retries; the
    //     `online` event and app reopen is the sanctioned retry point.
    //   - `uploading`: a row that the previous session left mid-transfer when
    //     the tab died. The `draining` guard means no live drain owns it now,
    //     so it's provably stale — flip it back to `queued` and the resume
    //     will re-use its persisted `tusUploadUrl`. Without this, an
    //     interrupted-reload upload would be stuck in `uploading` forever
    //     even though every byte we need to resume is on disk (FRI-14
    //     acceptance criterion 2, TECH_SPEC §5).
    // Bounded by `maxAttempts` so a genuinely broken photo can't spin every
    // reconnect. NB: we promote ONCE per drain (before the claim loop) —
    // a fresh failure in this drain waits for the next connectivity signal
    // instead of tight-looping.
    await promoteForRetry(deps);
    const tus = await deps.loadTus();
    // Loop until the queue is empty — new items enqueued during this drain
    // (or items freed up by the in-flight cap) get picked up in the next
    // claim without needing an external re-entry.
    while (true) {
      const claimed = await claimNext(deps.inFlightCap, deps.queue);
      if (claimed.length === 0) break;
      await Promise.all(claimed.map((item) => uploadOne(item, tus, deps)));
    }
  } finally {
    draining = false;
  }
}

async function promoteForRetry(deps: UploaderDeps): Promise<void> {
  // Both statuses are equally recoverable — the queue keeps `blob` +
  // `tusUploadUrl` for anything that hasn't reached `done`, so requeue
  // handles the resume the same way in both cases.
  const stranded = await getByStatus(["failed", "uploading"], deps.queue);
  await Promise.all(
    stranded
      // Blobless rows can't be retried (bytes freed on markDone or missing).
      // The attempts check keeps us from spinning on a poison item forever.
      .filter((item) => item.blob !== null && item.attempts < deps.maxAttempts)
      .map((item) => requeue(item.id, deps.queue)),
  );
}

function uploadOne(
  item: UploadItem,
  tus: TusModule,
  deps: UploaderDeps,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!item.blob) {
      // A row can lose its blob if it reached 'done' between the claim and
      // this call. Bail cleanly — the item is already terminal.
      resolve();
      return;
    }

    // Local mirror of the persisted URL so the URL-available callback only
    // writes once per unique URL (tus-js-client can emit the same URL
    // multiple times on HEAD probes during a resume).
    let lastPersistedUrl = item.tusUploadUrl ?? null;

    const upload = new tus.Upload(item.blob, {
      endpoint: deps.tusEndpoint,
      chunkSize: CHUNK_SIZE,
      retryDelays: RETRY_DELAYS,
      // Resume path: when we've been here before, hand tus the URL we saved
      // last time and it does a HEAD to figure out the byte offset itself.
      uploadUrl: item.tusUploadUrl,
      headers: deps.tusHeaders,
      metadata: {
        // Supabase reads `bucketName` + `objectName` (not `bucket`).
        bucketName: BUCKET,
        objectName: item.path,
        eventSlug: item.eventSlug,
        uploaderToken: item.uploaderToken,
        contentType: item.contentType,
      },
      onUploadUrlAvailable: () => {
        // Fires once the create POST returns (or right away on resume). This
        // is the write that makes full-page-reload resume work — if this URL
        // isn't in IndexedDB before the tab closes, the next drain re-POSTs
        // and the bytes we already sent are lost.
        const url = upload.url;
        if (url && url !== lastPersistedUrl) {
          lastPersistedUrl = url;
          void setTusUploadUrl(item.id, url, deps.queue);
        }
      },
      onProgress: (sent, total) => {
        // Durable so a reload can render the last known %.
        void setProgress(item.id, total ? sent / total : 0, deps.queue);
      },
      onSuccess: () => {
        void finishUpload(item, deps).then(resolve);
      },
      onError: (err) => {
        // tus-js-client has already burned through `retryDelays` before it
        // gets here. Surface the error so the guest sees a clear failed
        // state — the queue keeps the blob and the URL, so a retry (manual
        // or via a later `online` event) resumes from the last committed byte.
        const message = err?.message ?? "Upload failed";
        void markFailed(item.id, message, deps.queue).then(resolve);
      },
    });
    upload.start();
  });
}

/**
 * After TUS finishes streaming bytes, register the media row so the host
 * gallery can see the photo. If the register call itself fails, treat the
 * whole upload as failed — the bytes are on disk but the row is missing, so
 * a retry (which resumes at 100% and re-registers) is the recovery.
 */
async function finishUpload(item: UploadItem, deps: UploaderDeps): Promise<void> {
  try {
    const res = await deps.fetch(deps.registerEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: item.eventSlug,
        path: item.path,
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        contentHash: item.contentHash,
        uploaderToken: item.uploaderToken,
        uploaderName: item.uploaderName ?? null,
      }),
    });
    if (!res.ok) {
      const msg = await readRegisterError(res);
      await markFailed(item.id, msg, deps.queue);
      return;
    }
    await markDone(item.id, deps.queue);
  } catch (err) {
    // Network error hitting /api/uploads/register — same recovery as above.
    const msg = err instanceof Error ? err.message : "Register failed";
    await markFailed(item.id, msg, deps.queue);
  }
}

async function readRegisterError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (typeof data.error === "string" && data.error) return data.error;
  } catch {
    // fall through
  }
  return `Register failed (${res.status})`;
}

/**
 * Wire the uploader to the browser's connectivity signals:
 *   - Kick off a drain immediately (in case items are already queued from a
 *     previous session that closed mid-upload).
 *   - Re-drain whenever the tab regains connectivity (`online` event).
 *   - Register a Background Sync tag where the browser supports it so a drain
 *     fires even if the guest closes the tab before uploads finish. Chrome/
 *     Android supports this; Safari/iOS doesn't — the `online` listener is
 *     the fallback for the iPhone half of the room.
 *
 * SSR-safe: returns a no-op cleanup when there's no `window` (Next.js will
 * only mount this from a client component anyway).
 *
 * Returns a cleanup function so callers can detach listeners on unmount.
 */
export function startAutoDrain(overrides: Partial<UploaderDeps> = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const drain = (): void => {
    void drainQueue(overrides);
  };
  drain();
  window.addEventListener("online", drain);
  void registerBackgroundSync();
  return () => {
    window.removeEventListener("online", drain);
  };
}

/**
 * Ask the service worker for a Background Sync registration if the browser
 * supports it. When the guest closes the tab mid-upload and later comes
 * back online, the browser fires the sync event; the service worker's
 * handler is expected to call `drainQueue()` from within the SW context
 * (wired in a later issue — this file just requests the tag).
 */
async function registerBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined") return;
  const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
    .serviceWorker;
  if (!sw) return;
  try {
    const registration = await sw.ready;
    const withSync = registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    if (withSync.sync) await withSync.sync.register("gather-photo-drain");
  } catch {
    // Best-effort — Safari, private mode, and older browsers won't have this.
    // The `online` listener above is the fallback path.
  }
}

/** Test-only reset for the module-level `draining` guard between test cases. */
export function __resetForTests(): void {
  draining = false;
}
