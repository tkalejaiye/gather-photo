"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

// Guest upload UX. FRI-9 shipped the shell (name + pick); FRI-11 wired the
// one-shot direct path. FRI-14 rewires the whole thing onto the offline-first
// queue + resumable TUS uploader (TECH_SPEC §5, the prime directive):
//   compress → enqueue in IndexedDB (lib/upload/queue) → drainQueue drives
//   tus-js-client through Supabase Storage → register the media row.
//
// The queue is the source of truth. This component:
//   1. Loads the queue rows for THIS event on mount so a guest who reloaded
//      mid-upload sees their in-flight items reappear (progress + all).
//   2. Starts an auto-drain that fires on load, `online`, and page-visibility
//      returning to visible (Safari suspends background JS on iOS).
//   3. Polls the queue while non-terminal items exist so the UI reflects
//      progress updates that the uploader writes durably.
//
// Bundle budget (TECH_SPEC §8, ≤ 110 kB First Load JS on `/e/[slug]`):
// browser-image-compression, idb, tus-js-client, and the uploader itself
// are all behind dynamic imports so none of them enter the initial chunk.
// The direct-upload module (`lib/upload/direct`) is gone.

import type { UploadItem } from "@/lib/upload/queue";

const TOKEN_KEY = "gp_uploader_token";
const NAME_KEY = "gp_uploader_name";

/** How often to re-read the queue while there are non-terminal items. */
const POLL_MS = 400;

/**
 * Local, pre-enqueue view of a picked file. Compression runs on it, and once
 * it lands in IndexedDB the row is deleted from this map — the queue itself
 * takes over rendering that item.
 */
type Pending = {
  id: string;
  fileName: string;
  fileSize: number;
  state: "compressing" | "error";
  error?: string;
};

// `crypto.randomUUID()` requires a secure context and is missing from older
// Android WebViews / Transsion stock browsers (PRD §8). Fall back to a v4
// UUID built from `getRandomValues`, which has much wider support.
function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // fall through to manual v4
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / quota — best-effort, fall through
  }
}

function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

// Extension for the compressor's normalized JPEG output. The compressor always
// re-encodes to image/jpeg (see lib/image/compress.ts) so the storage path can
// safely hardcode `.jpg` — matches what `/api/uploads/register` allows through
// its PATH_TAIL check.
const OUTPUT_EXT = "jpg";
function buildStoragePath(eventId: string, objectId: string): string {
  return `events/${eventId}/${objectId}.${OUTPUT_EXT}`;
}

export function GuestUpload({
  slug,
  eventId,
}: {
  slug: string;
  eventId: string;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const tokenRef = useRef<string | null>(null);
  const nameInputId = useId();

  useEffect(() => {
    // Token must survive reloads so uploads can be attributed to one guest
    // across sessions (TECH_SPEC §5). Try to persist on every path.
    let token = readLocal(TOKEN_KEY);
    if (!token) {
      token = newUuid();
      writeLocal(TOKEN_KEY, token);
    }
    tokenRef.current = token;
    const stored = readLocal(NAME_KEY);
    if (stored) setName(stored);
  }, []);

  const refreshItems = useCallback(async () => {
    // Dynamic import so the queue module (and idb) stay out of the initial
    // chunk. The first refresh hits network once; subsequent calls are cached.
    const { getByStatus } = await import("@/lib/upload/queue");
    const rows = await getByStatus(["queued", "uploading", "done", "failed"]);
    // Multiple events could share the same IndexedDB (a guest hopping from
    // one QR to another). Filter to this event so /e/{other} rows don't leak.
    setItems(
      rows
        .filter((r) => r.eventSlug === slug)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }, [slug]);

  // Kick a drain and refresh. Drain is idempotent (its own re-entrancy guard),
  // so it's fine to call from mount + `online` + visibility + after-retry.
  const kickDrain = useCallback(async () => {
    const { drainQueue } = await import("@/lib/upload/uploader");
    void drainQueue();
    // Refresh once immediately so the UI flips 'queued' → 'uploading' fast.
    await refreshItems();
  }, [refreshItems]);

  useEffect(() => {
    // Mount: load the existing queue view (so reload-in-flight items reappear
    // with their real state), then start auto-drain listeners.
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      await refreshItems();
      if (cancelled) return;
      const { startAutoDrain } = await import("@/lib/upload/uploader");
      cleanup = startAutoDrain();
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [refreshItems]);

  useEffect(() => {
    // Re-kick a drain when the page becomes visible again. iOS Safari
    // suspends background JS on backgrounded tabs, so an upload frozen mid-
    // transfer needs a shove when the guest returns to the tab.
    function onVis() {
      if (document.visibilityState === "visible") void kickDrain();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [kickDrain]);

  const hasWork =
    pending.length > 0 ||
    items.some((i) => i.status === "queued" || i.status === "uploading");

  useEffect(() => {
    // Poll while there's non-terminal work. Cheap enough on IDB, and it means
    // the uploader doesn't need a pub/sub API into this component. We stop
    // when the queue settles so an idle tab doesn't churn.
    if (!hasWork) return;
    const t = setInterval(() => {
      void refreshItems();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [hasWork, refreshItems]);

  function onNameChange(value: string) {
    setName(value);
    if (value) writeLocal(NAME_KEY, value);
    else removeLocal(NAME_KEY);
  }

  async function onFilesPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const fresh = Array.from(event.target.files ?? []);
    // Reset the input so picking the same file again still fires onChange.
    event.target.value = "";
    if (fresh.length === 0) return;

    // Show every file immediately in a "compressing" state so the UI reacts
    // even before browser-image-compression has finished loading.
    const uploaderToken = tokenRef.current ?? "";
    const uploaderName = name.trim() ? name.trim() : undefined;
    const jobs = fresh.map((file) => ({
      id: newUuid(),
      file,
    }));
    setPending((prev) => [
      ...prev,
      ...jobs.map((j) => ({
        id: j.id,
        fileName: j.file.name,
        fileSize: j.file.size,
        state: "compressing" as const,
      })),
    ]);

    // Load compression + queue lazily on the first pick (bundle budget).
    const [{ compress }, { enqueue }] = await Promise.all([
      import("@/lib/image/compress"),
      import("@/lib/upload/queue"),
    ]);

    for (const job of jobs) {
      try {
        const compressed = await compress(job.file);
        await enqueue({
          id: job.id,
          eventSlug: slug,
          uploaderToken,
          uploaderName,
          blob: compressed.blob,
          path: buildStoragePath(eventId, job.id),
          contentType: compressed.blob.type || job.file.type || "image/jpeg",
          contentHash: compressed.contentHash,
          bytes: compressed.blob.size,
          width: compressed.width,
          height: compressed.height,
        });
        // The queue owns the row now — drop the local placeholder.
        setPending((prev) => prev.filter((p) => p.id !== job.id));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not process photo.";
        setPending((prev) =>
          prev.map((p) =>
            p.id === job.id ? { ...p, state: "error", error: message } : p,
          ),
        );
      }
    }

    // Kick a drain now so the just-enqueued items start uploading immediately
    // instead of waiting for the next poll tick.
    await kickDrain();
  }

  async function retryItem(id: string) {
    const { requeue } = await import("@/lib/upload/queue");
    await requeue(id);
    await kickDrain();
  }

  async function removeItem(id: string) {
    const { remove } = await import("@/lib/upload/queue");
    await remove(id);
    await refreshItems();
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  const totalTracked = pending.length + items.length;
  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  return (
    <div className="w-full space-y-5" data-slug={slug} data-event-id={eventId}>
      <label htmlFor={nameInputId} className="block">
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          Your name (optional)
        </span>
        <input
          id={nameInputId}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="So the host knows it was you"
          autoComplete="name"
          maxLength={60}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block w-full cursor-pointer rounded bg-brand px-4 py-3 text-center text-sm font-medium text-white">
            Take photo
          </span>
          <input
            type="file"
            accept="image/*"
            // `capture` is a hint; on desktop the file picker still works.
            capture="environment"
            onChange={onFilesPicked}
            className="sr-only"
          />
        </label>

        <label className="block">
          <span className="block w-full cursor-pointer rounded border border-neutral-700 px-4 py-3 text-center text-sm font-medium text-neutral-100">
            Choose photos
          </span>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={onFilesPicked}
            className="sr-only"
          />
        </label>
      </div>

      {totalTracked > 0 ? (
        <>
          <div
            aria-live="polite"
            className="flex items-center justify-between text-xs text-neutral-400"
          >
            <span>
              {doneCount} of {totalTracked} uploaded
              {failedCount > 0 ? ` · ${failedCount} failed` : ""}
            </span>
            {hasWork ? (
              // TECH_SPEC §8 + PRD §7: iOS pauses background JS. Uploads
              // resume when the guest returns, but the hint sets expectations
              // so they don't close the tab too fast.
              <span className="text-neutral-500">
                Keep this screen open until done.
              </span>
            ) : null}
          </div>

          <ul aria-label="Selected photos" className="space-y-2 text-left">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {p.fileName}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatBytes(p.fileSize)}
                </span>
                {p.state === "compressing" ? (
                  <span className="shrink-0 text-xs text-neutral-400">
                    Preparing…
                  </span>
                ) : (
                  <span
                    className="shrink-0 text-xs text-red-400"
                    title={p.error}
                  >
                    Failed
                  </span>
                )}
                {p.state === "error" ? (
                  <button
                    type="button"
                    onClick={() => removePending(p.id)}
                    aria-label={`Remove ${p.fileName}`}
                    className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}

            {items.map((item) => (
              <li
                key={item.id}
                data-item-id={item.id}
                data-status={item.status}
                className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {item.path.split("/").pop() ?? item.path}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatBytes(item.bytes)}
                </span>
                <QueueBadge item={item} />
                {item.status === "failed" ? (
                  <button
                    type="button"
                    onClick={() => retryItem(item.id)}
                    className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-800"
                  >
                    Retry
                  </button>
                ) : null}
                {item.status === "failed" || item.status === "done" ? (
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    aria-label="Remove"
                    className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-neutral-500">No photos selected yet.</p>
      )}
    </div>
  );
}

function QueueBadge({ item }: { item: UploadItem }) {
  switch (item.status) {
    case "queued":
      return <span className="shrink-0 text-xs text-neutral-400">Queued</span>;
    case "uploading":
      return (
        <span className="shrink-0 text-xs text-neutral-300">
          {Math.round((item.progress ?? 0) * 100)}%
        </span>
      );
    case "done":
      return (
        <span className="shrink-0 text-xs text-emerald-400">Uploaded</span>
      );
    case "failed":
      return (
        <span
          className="shrink-0 text-xs text-red-400"
          title={item.lastError ?? "Upload failed"}
        >
          Failed
        </span>
      );
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
