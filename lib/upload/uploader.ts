import * as tus from "tus-js-client";
import {
  claimNext,
  markDone,
  markFailed,
  setProgress,
  type UploadItem,
} from "./queue";

const RETRY_DELAYS = [0, 1000, 3000, 8000, 20000];

let draining = false;

/**
 * Drain the IndexedDB upload queue: upload each queued item via TUS resumable
 * upload to Supabase Storage, with backoff. Safe to call repeatedly (idempotent
 * via the `draining` guard). Trigger on app load and on `online`.
 *
 * TODO(M2): persist TUS upload URLs so uploads resume across reloads;
 * register the media row server-side on success.
 */
export async function drainQueue(): Promise<void> {
  if (draining || (typeof navigator !== "undefined" && !navigator.onLine)) return;
  draining = true;
  try {
    // The queue enforces the in-flight cap and atomically flips items to
    // 'uploading' so a re-entrant drainer can't double-claim the same row.
    const claimed = await claimNext();
    await Promise.all(claimed.map(uploadOne));
  } finally {
    draining = false;
  }
}

function uploadOne(item: UploadItem): Promise<void> {
  return new Promise((resolve) => {
    if (!item.blob) {
      // Terminal-done rows have their blob freed; nothing left to send.
      resolve();
      return;
    }
    const upload = new tus.Upload(item.blob, {
      endpoint: process.env.NEXT_PUBLIC_SUPABASE_TUS_ENDPOINT!,
      retryDelays: RETRY_DELAYS,
      // Supabase TUS requires a fixed 6MB chunk size; uploads stall otherwise.
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        // Supabase reads `bucketName` + `objectName` (not `bucket`).
        bucketName: "event-media",
        objectName: item.path,
        eventSlug: item.eventSlug,
        uploaderToken: item.uploaderToken,
        contentType: item.contentType,
      },
      onProgress: (sent, total) => {
        void setProgress(item.id, total ? sent / total : 0);
      },
      onSuccess: async () => {
        // TODO(M2): call /api/uploads/register to insert the media row.
        await markDone(item.id);
        resolve();
      },
      onError: async (err) => {
        await markFailed(item.id, err?.message);
        resolve();
      },
    });
    upload.start();
  });
}

export function startAutoDrain(): void {
  if (typeof window === "undefined") return;
  void drainQueue();
  window.addEventListener("online", drainQueue);
}
