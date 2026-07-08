"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Polaroid } from "@/components/ui/polaroid";

// Daylight guest flow (FRI-34) — Landing → Name → Picker → Uploading →
// Success, per design/daylight/README.md §Screens 1–5. This is a visual/
// structural pass only: the upload engine underneath (compress → IndexedDB
// queue → resumable TUS drain, TECH_SPEC §5/§8/§10) is used exactly as
// GuestUpload.tsx (FRI-14/25/32) left it.
//
// Flow semantics vs the mock:
//   - Picking files compresses + enqueues + starts uploading IMMEDIATELY
//     (the mock waits for "Add N shots"). On a congested venue network the
//     head start is invisible to the guest and pure reliability win; the
//     footer button just advances to the progress screen.
//   - The Uploading screen keeps the mock's ring/%/bar but adds the
//     per-item polaroid list (queued / % / done / failed with real error
//     text + retry/remove) — decided in the Jul 2026 design review. Success
//     shows only when every item in the batch is done; failures hold the
//     guest here with errors visible (TECH_SPEC §8: no silent failures).
//   - A reload/revisit with unfinished queue rows for this event jumps
//     straight to the Uploading screen and resumes.
//
// Bundle budget (TECH_SPEC §8, ≤ 110 kB First Load JS): compression, idb,
// tus and the uploader stay behind dynamic imports; animations are CSS-only
// (gp-* keyframes from tailwind.config).

import type { UploadItem } from "@/lib/upload/queue";

const TOKEN_KEY = "gp_uploader_token";
const NAME_KEY = "gp_uploader_name";

/** How often to re-read the queue while there are non-terminal items. */
const POLL_MS = 400;

/**
 * How long failed rows keep their calm "waiting" presentation after the
 * network returns. The engine's `online` drain requeues them within ~a
 * second; flashing red FAILED in that gap reads like the recovery didn't
 * work. A genuine failure outlives this window and shows red + Retry.
 */
const RECONNECT_GRACE_MS = 4000;

type Screen = "landing" | "name" | "picker" | "uploading" | "success";

/**
 * Local, pre-enqueue view of a picked file. Compression runs on it, and once
 * it lands in IndexedDB the row is deleted from this map — the queue itself
 * takes over rendering that item.
 */
type Pending = {
  id: string;
  fileName: string;
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

// Extension for the compressor's normalized JPEG output. The compressor always
// re-encodes to image/jpeg (see lib/image/compress.ts) so the storage path can
// safely hardcode `.jpg` — matches what `/api/uploads/register` allows through
// its PATH_TAIL check.
const OUTPUT_EXT = "jpg";
function buildStoragePath(eventId: string, objectId: string): string {
  return `events/${eventId}/${objectId}.${OUTPUT_EXT}`;
}

// Photo-placeholder gradients from the handoff (README §Design Tokens),
// rotated by index wherever we have no real thumbnail (e.g. after a reload,
// when the pick-time object URL is gone but the queue row survives).
const PLACEHOLDER_GRADIENTS = [
  "linear-gradient(150deg,#F5852A,#a34a12)",
  "linear-gradient(150deg,#17B7A6,#0c5b52)",
  "linear-gradient(150deg,#E8503B,#8a1c12)",
  "linear-gradient(150deg,#E9C33C,#a3791c)",
  "linear-gradient(150deg,#3FA7A0,#0e4a44)",
  "linear-gradient(150deg,#D96A2B,#8a3a10)",
  "linear-gradient(150deg,#F0A83C,#a3791c)",
  "linear-gradient(150deg,#C98A3A,#6e3d12)",
];
function placeholderGradient(i: number): string {
  return PLACEHOLDER_GRADIENTS[i % PLACEHOLDER_GRADIENTS.length];
}

// "LAKE HOUSE'26" — the mock colors the apostrophe-year orange. Real event
// names may not have one: fall back to the last word when there are several,
// or no accent for single-word names.
function splitEventName(name: string): { base: string; accent: string } {
  const yearSuffix = name.match(/^(.*?)(\s*['’]\s?\d{2})$/);
  if (yearSuffix) return { base: yearSuffix[1], accent: yearSuffix[2] };
  const words = name.trim().split(/\s+/);
  if (words.length > 1) {
    const accent = words[words.length - 1];
    return { base: words.slice(0, -1).join(" ") + " ", accent };
  }
  return { base: name, accent: "" };
}

// Film-style date stamp, e.g. "2026-07-04" → "07·04·26" (mock format).
function formatStamp(isoDate: string | null): string | null {
  const m = isoDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[2]}·${m[3]}·${m[1].slice(2)}`;
}

export function GuestFlow({
  slug,
  eventId,
  eventName,
  eventDate,
  mediaCount,
}: {
  slug: string;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  mediaCount: number;
}) {
  const [screen, setScreen] = useState<Screen>("landing");
  const [name, setName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  // Ids picked this session (or unfinished at mount) — the "batch" the
  // picker tray, progress screen, and success count all render. Done rows
  // from older sessions stay in IndexedDB but out of the UI.
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  // True from the `online` event until the engine has requeued the rows that
  // failed while offline (or RECONNECT_GRACE_MS passes) — see maskFailures.
  const [reconnectGrace, setReconnectGrace] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef<string | null>(null);
  // Pick-time object URLs for thumbnails, keyed by item id. Gone after a
  // reload — rows fall back to placeholder gradients.
  const previewsRef = useRef<Map<string, string>>(new Map());

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
    if (stored) {
      setName(stored);
      setDraftName(stored);
    }
  }, []);

  useEffect(() => {
    const previews = previewsRef.current;
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
    };
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
    // Mount: load the existing queue view. A guest who reloaded (or closed
    // the tab) mid-upload has unfinished rows — adopt them as the batch and
    // jump straight to the progress screen so the auto-resume is visible
    // instead of silently draining behind the landing page.
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      const { getByStatus } = await import("@/lib/upload/queue");
      const rows = await getByStatus(["queued", "uploading", "done", "failed"]);
      if (cancelled) return;
      const mine = rows
        .filter((r) => r.eventSlug === slug)
        .sort((a, b) => a.createdAt - b.createdAt);
      setItems(mine);
      const unfinished = mine.filter((r) => r.status !== "done");
      if (unfinished.length > 0) {
        setBatchIds(unfinished.map((r) => r.id));
        setScreen("uploading");
      }
      const { startAutoDrain } = await import("@/lib/upload/uploader");
      cleanup = startAutoDrain();
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [slug]);

  useEffect(() => {
    // Track connectivity for the progress-screen messaging, and nudge both
    // the queue and this component's view on reconnect. The engine's own
    // `online` listener re-drains durably regardless; the kick here makes
    // sure the poll loop restarts when everything had already settled into
    // `failed` (hasWork false → poll stopped) so the UI keeps its "resumes
    // automatically" promise without waiting for a visibility change.
    function onOnline() {
      setOffline(false);
      // Hold the calm presentation through the reconnect handoff — the
      // effect below drops it as soon as the requeue lands, the timer is
      // the cap for rows the engine declines to requeue.
      setReconnectGrace(true);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(
        () => setReconnectGrace(false),
        RECONNECT_GRACE_MS,
      );
      void kickDrain();
    }
    function onOffline() {
      setOffline(true);
    }
    setOffline(!navigator.onLine);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    };
  }, [kickDrain]);

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
    pending.some((p) => p.state === "compressing") ||
    items.some((i) => i.status === "queued" || i.status === "uploading");

  const batchSet = new Set(batchIds);
  const batchItems = items.filter((i) => batchSet.has(i.id));
  const compressingCount = pending.filter((p) => p.state === "compressing").length;
  const trayCount = pending.length + batchItems.length;
  // What "Add N shots" actually adds — compress-failed picks don't count.
  const addableCount = compressingCount + batchItems.length;

  const failedItemCount = batchItems.filter((i) => i.status === "failed").length;
  const pendingErrorCount = pending.filter((p) => p.state === "error").length;
  const failedCount = failedItemCount + pendingErrorCount;
  const allDone =
    batchItems.length > 0 &&
    pending.length === 0 &&
    batchItems.every((i) => i.status === "done");

  // Failed queue rows read as calmly "waiting" while offline and through the
  // reconnect grace window — the engine auto-requeues them on `online`, so
  // red FAILED + a dead Retry button would misdescribe both states. Genuine
  // failures outlive the grace and show red. Compress errors (pending) are
  // never network-caused and are never masked.
  const maskFailures = offline || reconnectGrace;
  const visibleFailedCount =
    (maskFailures ? 0 : failedItemCount) + pendingErrorCount;

  useEffect(() => {
    // Poll while there's non-terminal work — and on the progress screen,
    // until the batch is actually finished. The wider condition matters
    // after a reconnect: rows sit in `failed` (hasWork false) while the
    // engine's own drain requeues them, and without polling the view would
    // stay stuck on stale failures while uploads proceed underneath.
    // Cheap enough on IDB, and it means the uploader doesn't need a pub/sub
    // API into this component.
    const shouldPoll = hasWork || (screen === "uploading" && !allDone);
    if (!shouldPoll) return;
    const t = setInterval(() => {
      void refreshItems();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [hasWork, screen, allDone, refreshItems]);

  useEffect(() => {
    // Drop the reconnect grace as soon as no failed rows remain (the requeue
    // landed); the RECONNECT_GRACE_MS timer caps the rows that the engine
    // declined to requeue (attempts exhausted).
    if (reconnectGrace && failedItemCount === 0) setReconnectGrace(false);
  }, [reconnectGrace, failedItemCount]);

  // Aggregate progress across the batch for the ring + linear bar.
  const progressDenominator = compressingCount + batchItems.length;
  const progressSum = batchItems.reduce(
    (sum, i) => sum + (i.status === "done" ? 1 : i.progress ?? 0),
    0,
  );
  const overallPct =
    progressDenominator === 0
      ? 0
      : Math.round((progressSum / progressDenominator) * 100);

  useEffect(() => {
    // Auto-advance to Success ONLY once every batch item has completed
    // (TECH_SPEC §8). Failures keep the guest here with errors visible.
    if (screen !== "uploading" || !allDone) return;
    const t = setTimeout(() => setScreen("success"), 600);
    return () => clearTimeout(t);
  }, [screen, allDone]);

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
    for (const job of jobs) {
      try {
        previewsRef.current.set(job.id, URL.createObjectURL(job.file));
      } catch {
        // no preview — the tray falls back to a gradient
      }
    }
    setBatchIds((prev) => [...prev, ...jobs.map((j) => j.id)]);
    setPending((prev) => [
      ...prev,
      ...jobs.map((j) => ({
        id: j.id,
        fileName: j.file.name,
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
        // Materialize the compressed image as a raw ArrayBuffer BEFORE it
        // touches IndexedDB. iOS Safari's IDB silently file-backs any stored
        // Blob and then the fetch layer refuses to send it as a request body
        // (see `lib/upload/queue.ts` header). ArrayBuffer is durably stored
        // as plain bytes and the uploader re-wraps it in a fresh in-memory
        // Blob at upload time.
        const data = await compressed.blob.arrayBuffer();
        await enqueue({
          id: job.id,
          eventSlug: slug,
          uploaderToken,
          uploaderName,
          data,
          path: buildStoragePath(eventId, job.id),
          contentType: compressed.blob.type || job.file.type || "image/jpeg",
          contentHash: compressed.contentHash,
          bytes: data.byteLength,
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
    // instead of waiting for "Add N shots" — on a hostile venue network the
    // head start matters, and the progress screen shows true state anyway.
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
    dropPreview(id);
    setBatchIds((prev) => prev.filter((b) => b !== id));
    await refreshItems();
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
    setBatchIds((prev) => prev.filter((b) => b !== id));
    dropPreview(id);
  }

  function dropPreview(id: string) {
    const url = previewsRef.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      previewsRef.current.delete(id);
    }
  }

  function continueFromName() {
    const trimmed = draftName.trim();
    if (!trimmed) return;
    setName(trimmed);
    writeLocal(NAME_KEY, trimmed);
    setScreen("picker");
  }

  function addMore() {
    // New batch: the finished rows stay 'done' in IndexedDB but leave the UI,
    // so their preview object URLs are dead weight — free them now instead
    // of holding blobs until unmount (guests can shoot for hours).
    for (const id of batchIds) dropPreview(id);
    setBatchIds([]);
    setScreen("picker");
  }

  const stamp = formatStamp(eventDate);

  return (
    <div
      className="flex flex-1 flex-col"
      data-slug={slug}
      data-event-id={eventId}
      data-screen={screen}
    >
      {screen === "landing" && (
        <LandingScreen
          eventName={eventName}
          stamp={stamp}
          mediaCount={mediaCount}
          onStart={() => setScreen(name.trim() ? "picker" : "name")}
        />
      )}

      {screen === "name" && (
        <div
          key="name"
          className="flex flex-1 animate-gp-fade flex-col px-[26px] pb-11 pt-10"
        >
          <BackButton onClick={() => setScreen("landing")} />
          <div className="flex flex-1 flex-col justify-center gap-[26px]">
            <div className="flex justify-center">
              <div
                aria-hidden
                className="flex h-24 w-24 items-center justify-center rounded-[24px] bg-daylight-orange-grad font-display text-[44px] text-white shadow-[0_16px_34px_rgba(255,106,0,0.4)]"
              >
                {draftName.trim() ? draftName.trim()[0].toUpperCase() : "?"}
              </div>
            </div>
            <div className="text-center">
              <Eyebrow className="mb-3">ONE QUICK THING</Eyebrow>
              <h1 className="font-display text-[34px] tracking-[0.005em]">
                What&apos;s your name?
              </h1>
              <p className="mt-[10px] text-[15px] leading-snug text-daylight-ink-soft">
                So friends know whose shots are whose.
              </p>
            </div>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") continueFromName();
              }}
              placeholder="e.g. Priya"
              autoComplete="name"
              maxLength={40}
              aria-label="Your name"
              className="w-full rounded-daylight-btn border border-daylight-rule bg-white/60 p-[18px] text-center font-sans text-xl font-bold text-daylight-ink outline-none transition focus:border-daylight-orange focus:shadow-daylight-focus"
            />
          </div>
          <Button
            className="w-full"
            disabled={!draftName.trim()}
            onClick={continueFromName}
          >
            Continue
          </Button>
        </div>
      )}

      {screen === "picker" && (
        <div
          key="picker"
          className="flex flex-1 animate-gp-fade flex-col px-[26px] pb-11 pt-10"
        >
          <div className="flex items-center justify-between">
            <BackButton onClick={() => setScreen("landing")} />
            <div className="font-mono text-[13px] text-daylight-muted">
              Hi, {name.trim() || "guest"}
            </div>
          </div>

          <div className="mt-7">
            <Eyebrow className="mb-[10px]">ADD TO THE ROLL</Eyebrow>
            <h1 className="font-display text-[34px] tracking-[0.005em]">
              Pick your shots
            </h1>
          </div>

          <div className="mt-6 flex gap-3.5">
            <label className="flex aspect-square flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-daylight-card-lg bg-daylight-orange-grad text-white shadow-[0_12px_28px_rgba(255,106,0,0.32)] transition active:scale-[0.96]">
              <span aria-hidden className="text-[40px] leading-none">
                ◉
              </span>
              <span className="font-display text-sm uppercase">
                Take a photo
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
            <label className="flex aspect-square flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-daylight-card-lg border border-daylight-rule bg-white/[0.55] text-daylight-ink transition active:scale-[0.96]">
              <span aria-hidden className="text-[38px] leading-none">
                ▦
              </span>
              <span className="font-display text-sm uppercase">Library</span>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={onFilesPicked}
                className="sr-only"
              />
            </label>
          </div>

          <div className="mt-6 flex flex-1 flex-col justify-end">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-display text-[13px] uppercase text-daylight-ink">
                Selected
              </span>
              <span className="font-mono text-xs text-daylight-muted" aria-live="polite">
                {compressingCount > 0
                  ? `preparing ${compressingCount}…`
                  : `${addableCount} ready`}
              </span>
            </div>
            {trayCount > 0 ? (
              <div className="flex gap-[10px] overflow-x-auto pb-1.5">
                {batchItems.map((item, i) => (
                  <TrayThumb
                    key={item.id}
                    url={previewsRef.current.get(item.id)}
                    gradient={placeholderGradient(i)}
                  />
                ))}
                {pending.map((p, i) => (
                  <TrayThumb
                    key={p.id}
                    url={previewsRef.current.get(p.id)}
                    gradient={placeholderGradient(batchItems.length + i)}
                    compressing={p.state === "compressing"}
                    error={p.state === "error"}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-daylight-card border border-dashed border-daylight-rule bg-white/30 px-4 py-6 text-center text-sm text-daylight-muted">
                Nothing yet — take a photo or open your library.
              </p>
            )}
            {pending
              .filter((p) => p.state === "error")
              .map((p) => (
                <div
                  key={p.id}
                  data-pending-id={p.id}
                  data-pending-state={p.state}
                  className="mt-2 flex items-start justify-between gap-3 rounded-daylight-card border border-daylight-red/40 bg-white/50 px-3 py-2"
                >
                  <p
                    data-error-detail=""
                    className="min-w-0 break-words font-mono text-[11px] text-daylight-red-deep"
                  >
                    {p.fileName}: {p.error ?? "Could not process photo."}
                  </p>
                  <button
                    type="button"
                    onClick={() => removePending(p.id)}
                    className="shrink-0 font-mono text-[11px] font-bold uppercase text-daylight-muted transition active:scale-[0.95]"
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>

          <Button
            className="mt-5 w-full"
            disabled={addableCount === 0}
            onClick={() => setScreen("uploading")}
          >
            Add {addableCount === 1 ? "1 shot" : `${addableCount} shots`}
          </Button>
        </div>
      )}

      {screen === "uploading" && (
        <div
          key="uploading"
          className="flex flex-1 animate-gp-fade flex-col items-center px-[26px] pb-11 pt-10 text-center"
        >
          <div className="flex w-full flex-1 flex-col items-center justify-center py-6">
            <div className="relative mb-9 h-[150px] w-[150px]">
              <div className="absolute inset-0 rounded-full border-8 border-daylight-ink/[0.08]" />
              <div
                className={cx(
                  "absolute inset-0 rounded-full border-8 border-transparent [border-right-color:#FF8A1E] [border-top-color:#FF6A00]",
                  hasWork && "animate-gp-spin",
                )}
              />
              <div
                className="absolute inset-0 flex items-center justify-center font-display text-[34px] text-daylight-ink"
                aria-live="polite"
              >
                {overallPct}%
              </div>
            </div>

            <h1 className="font-display text-[26px] text-daylight-ink">
              {allDone
                ? "All in!"
                : offline
                  ? "Waiting for network…"
                  : visibleFailedCount > 0 && !hasWork
                    ? "Some shots need a retry"
                    : "Adding your shots…"}
            </h1>
            <p className="mt-[10px] text-[15px] text-daylight-ink-soft">
              {offline
                ? // Hard-offline fails fast (tus skips its retry schedule when
                  // navigator.onLine is false) but the queue is durable and the
                  // engine auto-requeues on `online` — say so instead of asking
                  // for a manual retry that isn't needed.
                  "Your shots are saved on this phone — they'll retry on their own once you're back online."
                : visibleFailedCount > 0 && !hasWork
                  ? "Check the errors below — nothing is lost."
                  : "Hang tight — landing in the roll."}
            </p>

            <div className="mt-[26px] h-[10px] w-full max-w-[280px] overflow-hidden rounded-pill bg-daylight-ink/[0.08]">
              <div
                className="h-full rounded-pill bg-daylight-orange-grad transition-[width] duration-200"
                style={{ width: `${overallPct}%` }}
              />
            </div>

            {hasWork || (offline && failedCount > 0) ? (
              // TECH_SPEC §8 + PRD §7: iOS pauses background JS. Uploads
              // resume when the guest returns, but the hint sets expectations
              // so they don't close the tab too fast. Kept visible while
              // offline even when every item has flipped to failed — that's
              // exactly when the guest needs it.
              <p className="mt-4 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-daylight-muted">
                {offline
                  ? "You're offline — uploads resume automatically"
                  : "Keep this screen open"}
              </p>
            ) : null}

            <ul aria-label="Your shots" className="mt-8 w-full space-y-2 text-left">
              {pending.map((p, i) => (
                <li
                  key={p.id}
                  data-pending-id={p.id}
                  data-pending-state={p.state}
                  className={cx(
                    "flex items-center gap-3 rounded-daylight-card border bg-white/50 p-3",
                    p.state === "error"
                      ? "border-daylight-red/40"
                      : "border-daylight-rule-light",
                  )}
                >
                  <ItemThumb
                    url={previewsRef.current.get(p.id)}
                    gradient={placeholderGradient(batchItems.length + i)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] font-bold text-daylight-ink">
                        {p.fileName}
                      </span>
                      {p.state === "compressing" ? (
                        <span className="shrink-0 animate-pulse-soft font-mono text-[11px] font-bold uppercase text-daylight-muted">
                          Preparing…
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          className="shrink-0 font-mono text-[11px] font-bold uppercase text-daylight-muted transition active:scale-[0.95]"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {p.state === "error" && p.error ? (
                      <p
                        data-error-detail=""
                        className="mt-1 break-words font-mono text-[11px] text-daylight-red-deep"
                      >
                        {p.error}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}

              {batchItems.map((item, i) => (
                <li
                  key={item.id}
                  data-item-id={item.id}
                  data-status={item.status}
                  className={cx(
                    "flex items-center gap-3 rounded-daylight-card border bg-white/50 p-3",
                    item.status === "failed" && !maskFailures
                      ? "border-daylight-red/40"
                      : "border-daylight-rule-light",
                  )}
                >
                  <ItemThumb
                    url={previewsRef.current.get(item.id)}
                    gradient={placeholderGradient(i)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] font-bold uppercase text-daylight-ink">
                        Shot {i + 1}
                        <span className="ml-2 font-normal normal-case text-daylight-muted">
                          {formatBytes(item.bytes)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <QueueBadge item={item} masked={maskFailures} />
                        {item.status === "failed" ? (
                          <>
                            {!maskFailures ? (
                              <button
                                type="button"
                                onClick={() => retryItem(item.id)}
                                className="rounded-daylight-chip border border-daylight-rule bg-white/60 px-2.5 py-1 font-mono text-[11px] font-bold uppercase text-daylight-ink transition active:scale-[0.95]"
                              >
                                Retry
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => removeItem(item.id)}
                              className="font-mono text-[11px] font-bold uppercase text-daylight-muted transition active:scale-[0.95]"
                            >
                              Remove
                            </button>
                          </>
                        ) : null}
                      </span>
                    </div>
                    {item.status === "uploading" ? (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-daylight-ink/[0.08]">
                        <div
                          className="h-full rounded-pill bg-daylight-orange-grad transition-[width] duration-200"
                          style={{
                            width: `${Math.round((item.progress ?? 0) * 100)}%`,
                          }}
                        />
                      </div>
                    ) : null}
                    {item.status === "failed" && item.lastError && !maskFailures ? (
                      <p
                        data-error-detail=""
                        className="mt-1 break-words font-mono text-[11px] text-daylight-red-deep"
                      >
                        {item.lastError}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {screen === "success" && (
        <div
          key="success"
          className="flex flex-1 animate-gp-fade flex-col items-center px-[34px] pb-11 pt-10 text-center"
        >
          <div className="flex flex-1 flex-col items-center justify-center gap-[26px]">
            <div className="flex h-[116px] w-[116px] animate-gp-pop items-center justify-center rounded-full bg-daylight-orange-grad shadow-[0_18px_40px_rgba(255,106,0,0.42)]">
              <svg
                width="52"
                height="52"
                viewBox="0 0 52 52"
                fill="none"
                aria-hidden
              >
                <path
                  d="M14 27l9 9 16-18"
                  stroke="#fff"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <h1 className="font-display text-[38px] tracking-[0.005em] text-daylight-ink">
                You&apos;re in the roll!
              </h1>
              <p className="mx-auto mt-3 max-w-[280px] text-base leading-normal text-daylight-ink-soft">
                {batchItems.length === 1
                  ? "1 shot"
                  : `${batchItems.length} shots`}{" "}
                added. Everyone at {eventName} can see them now.
              </p>
            </div>
          </div>
          <Button variant="secondary" className="w-full" onClick={addMore}>
            ADD MORE
          </Button>
        </div>
      )}
    </div>
  );
}

function LandingScreen({
  eventName,
  stamp,
  mediaCount,
  onStart,
}: {
  eventName: string;
  stamp: string | null;
  mediaCount: number;
  onStart: () => void;
}) {
  const { base, accent } = splitEventName(eventName);
  return (
    <div
      key="landing"
      className="flex flex-1 animate-gp-fade flex-col px-[26px] pb-11 pt-14"
    >
      <Eyebrow className="flex items-center gap-[9px]">
        <span
          aria-hidden
          className="h-[7px] w-[7px] animate-gp-blink rounded-full bg-daylight-orange shadow-[0_0_9px_rgba(255,106,0,0.7)]"
        />
        ROLL · LIVE
      </Eyebrow>

      <div className="flex flex-1 flex-col justify-center gap-5 py-6">
        <div>
          <h1 className="break-words font-display text-[54px] uppercase leading-[0.88] tracking-[0.005em] text-daylight-ink">
            {base}
            {accent ? <span className="text-daylight-orange">{accent}</span> : null}
          </h1>
          {stamp ? (
            <div className="mt-3 font-mono text-xs text-daylight-muted">
              {stamp}
            </div>
          ) : null}
        </div>

        <p className="max-w-[300px] text-base leading-normal text-daylight-ink-soft">
          Snap or upload from the event. Everyone&apos;s shots land in one live
          roll — no app, no login.
        </p>

        <div aria-hidden className="relative my-1 h-[150px]">
          <Polaroid
            rotate={-9}
            float
            className="absolute left-[6px] top-[14px] w-[116px]"
          >
            <div
              className="h-24"
              style={{ background: "linear-gradient(150deg,#17B7A6,#0c5b52)" }}
            />
          </Polaroid>
          <Polaroid
            rotate={4}
            float
            floatDelay=".5s"
            dateStamp={stamp ?? undefined}
            className="absolute left-[100px] top-1 w-[118px]"
          >
            <div
              className="h-[100px]"
              style={{ background: "linear-gradient(150deg,#F5852A,#a34a12)" }}
            />
          </Polaroid>
          <Polaroid
            rotate={11}
            float
            floatDelay="1s"
            padding="7px 7px 22px"
            className="absolute right-[2px] top-[22px] w-[100px]"
          >
            <div
              className="h-[84px]"
              style={{ background: "linear-gradient(150deg,#E9C33C,#a3791c)" }}
            />
          </Polaroid>
        </div>

        <div className="self-start rounded-daylight-chip border border-daylight-rule bg-white/40 px-[13px] py-2 font-mono text-[11px] text-daylight-ink">
          ◉ {mediaCount} {mediaCount === 1 ? "SHOT" : "SHOTS"} IN THE ROLL
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button className="w-full" onClick={onStart}>
          ◉&nbsp;&nbsp;Add your shots
        </Button>
        <a
          href="/sign-in"
          className="p-1.5 text-center font-mono text-xs text-daylight-muted transition active:scale-[0.97]"
        >
          Hosting this event?{" "}
          <span className="font-bold text-daylight-orange-deep">Manage →</span>
        </a>
      </div>
    </div>
  );
}

function TrayThumb({
  url,
  gradient,
  compressing = false,
  error = false,
}: {
  url: string | undefined;
  gradient: string;
  compressing?: boolean;
  error?: boolean;
}) {
  return (
    <div
      className={cx(
        "w-20 flex-none rounded-daylight-print bg-white p-[5px] pb-4 shadow-[0_6px_14px_rgba(90,70,30,0.2)]",
        compressing && "animate-pulse-soft",
        error && "ring-2 ring-daylight-red/60",
      )}
    >
      <div
        className="h-[84px] overflow-hidden"
        style={url ? undefined : { background: gradient }}
      >
        {url ? (
          // Pick-time blob preview — next/image can't optimize object URLs.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
    </div>
  );
}

function ItemThumb({
  url,
  gradient,
}: {
  url: string | undefined;
  gradient: string;
}) {
  return (
    <div className="w-11 flex-none rounded-daylight-print bg-white p-[3px] pb-2 shadow-[0_3px_8px_rgba(90,70,30,0.18)]">
      <div
        className="h-10 overflow-hidden"
        style={url ? undefined : { background: gradient }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
    </div>
  );
}

function QueueBadge({ item, masked }: { item: UploadItem; masked: boolean }) {
  switch (item.status) {
    case "queued":
      return (
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-daylight-muted">
          Queued
        </span>
      );
    case "uploading":
      return (
        <span className="font-mono text-[11px] font-bold text-daylight-ink">
          {Math.round((item.progress ?? 0) * 100)}%
        </span>
      );
    case "done":
      return (
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-daylight-teal-deep">
          Done ✓
        </span>
      );
    case "failed":
      // Masked (offline or reconnect grace), 'failed' just means "the network
      // went away mid-transfer" — deliberately not phrased as a promise of
      // auto-retry, since an item that exhausted MAX_ATTEMPTS reverts to a
      // red Failed (+ Retry) after the grace instead of resuming on its own.
      return masked ? (
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-daylight-muted">
          Waiting
        </span>
      ) : (
        <span
          className="font-mono text-[11px] font-bold uppercase tracking-wide text-daylight-red"
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
