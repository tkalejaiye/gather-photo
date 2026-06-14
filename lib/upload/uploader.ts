import * as tus from "tus-js-client";
import { getByStatus, update, type UploadItem } from "./queue";

const RETRY_DELAYS = [0, 1000, 3000, 8000, 20000];

let draining = false;

/**
 * Drain the IndexedDB upload queue: upload each queued/failed item via TUS
 * resumable upload to Supabase Storage, with backoff. Safe to call repeatedly
 * (idempotent via the `draining` guard). Trigger on app load and on `online`.
 *
 * TODO(M2): persist TUS upload URLs so uploads resume across reloads;
 * register the media row server-side on success; enforce in-flight queue cap.
 */
export async function drainQueue(): Promise<void> {
  if (draining || (typeof navigator !== "undefined" && !navigator.onLine)) return;
  draining = true;
  try {
    const items = await getByStatus(["queued", "failed"]);
    for (const item of items) {
      await uploadOne(item);
    }
  } finally {
    draining = false;
  }
}

function uploadOne(item: UploadItem): Promise<void> {
  return new Promise((resolve) => {
    update(item.id, { status: "uploading", attempts: item.attempts + 1 });
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
        contentType: item.blob.type,
      },
      onProgress: (sent, total) => update(item.id, { progress: total ? sent / total : 0 }),
      onSuccess: async () => {
        // TODO(M2): call /api/media/register to insert the media row
        await update(item.id, { status: "done", progress: 1 });
        resolve();
      },
      onError: async () => {
        await update(item.id, { status: "failed" });
        resolve();
      },
    });
    upload.start();
  });
}

export function startAutoDrain(): void {
  if (typeof window === "undefined") return;
  drainQueue();
  window.addEventListener("online", drainQueue);
}
