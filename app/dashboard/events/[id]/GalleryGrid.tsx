"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { GalleryItem, GalleryPage, UploaderSummary } from "@/lib/gallery/queries";

// FRI-16 + FRI-17: host gallery grid with soft-delete moderation.
// - Uploader filter (Everyone + one pill per uploader token, including anon)
// - Responsive thumbnail grid served by short-lived signed URLs (server-side)
// - Lazy-loaded next pages via IntersectionObserver
// - Tap a thumbnail for full-size lightbox
// - Select mode: multi-select + delete N; single-item delete inside the lightbox
//
// FRI-36 restyled this in Daylight ("Recent uploads" pane of D4 / the mobile
// Moderate grid): tiles are polaroid prints with uploader-name chins, the
// lightbox is the D3 dark-scrim treatment. Behavior is unchanged; the ZIP
// download moved up to the page's share/stats column (PRD §7 prominence).
//
// Kept as a lean client component: no state manager, no image lib. The initial
// page is server-rendered so first paint shows photos immediately; subsequent
// pages arrive via /api/events/[id]/media.

type Props = {
  eventId: string;
  totalCount: number;
  uploaders: UploaderSummary[];
  initialPage: GalleryPage;
};

type FilterValue = "all" | { token: string | null };

function buildQuery(offset: number, limit: number, f: FilterValue): string {
  const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (f !== "all") {
    // Empty string means anonymous — the API interprets `has("uploader") &&
    // value === ""` as "filter to NULL uploader_token" (see the route file).
    qs.set("uploader", f.token ?? "");
  }
  return qs.toString();
}

function labelFor(uploader: UploaderSummary): string {
  if (uploader.token === "") return "Anonymous";
  return uploader.displayName ?? "Guest";
}

export function GalleryGrid({ eventId, totalCount, uploaders, initialPage }: Props) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [items, setItems] = useState<GalleryItem[]>(initialPage.items);
  const [nextOffset, setNextOffset] = useState<number | null>(initialPage.nextOffset);
  const [hasMore, setHasMore] = useState<boolean>(initialPage.hasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // FRI-17 moderation state. `selectMode` gates whether tapping a thumb picks
  // it or opens the lightbox. Selected ids are a Set so add/remove is O(1);
  // rendering iterates the visible items (small) so lookup cost is amortised.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The uploader-summary counts are server-rendered once; after a delete we
  // decrement the affected uploader locally so the pills stay in sync without
  // a round-trip.
  const [uploaderSummary, setUploaderSummary] = useState<UploaderSummary[]>(uploaders);
  const [visibleTotal, setVisibleTotal] = useState<number>(totalCount);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guard against concurrent fetches when the sentinel becomes visible while a
  // page is still in-flight. Also lets us abort in-flight requests when the
  // filter changes so a slow first page can't clobber a fresh selection.
  const abortRef = useRef<AbortController | null>(null);

  // The filter total drives the "Showing X of Y" line without an extra API
  // trip. Falls back to visibleTotal when the "all" filter is active.
  const filterTotal = useMemo(() => {
    if (filter === "all") return visibleTotal;
    const match = uploaderSummary.find(
      (u) => (filter.token === null ? u.token === "" : u.token === filter.token),
    );
    return match?.count ?? 0;
  }, [filter, visibleTotal, uploaderSummary]);

  const fetchPage = useCallback(
    async (offset: number, activeFilter: FilterValue, mode: "replace" | "append") => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/events/${eventId}/media?${buildQuery(offset, 60, activeFilter)}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = (await res.json()) as GalleryPage;
        setItems((prev) => (mode === "append" ? [...prev, ...page.items] : page.items));
        setNextOffset(page.nextOffset);
        setHasMore(page.hasMore);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError("Couldn't load more photos. Retry.");
      } finally {
        if (abortRef.current === ctrl) {
          setLoading(false);
          abortRef.current = null;
        }
      }
    },
    [eventId],
  );

  // Filter change → reset the list and refetch from offset 0. Skip only the
  // very first render; the initial page was already rendered server-side for
  // filter="all". Comparing against a static "initial filter value" is wrong
  // because clicking "Everyone" after selecting a guest would then be treated
  // as a no-op and leave the grid stuck on the previous filter's results.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setItems([]);
    setNextOffset(0);
    setHasMore(true);
    fetchPage(0, filter, "replace");
  }, [filter, fetchPage]);

  // Load-more sentinel — when it scrolls into view, fetch the next offset.
  // rootMargin lets us start fetching before the sentinel is fully visible so
  // the user rarely sees a spinner unless the network is truly slow.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!hasMore || nextOffset === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          fetchPage(nextOffset, filter, "append");
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, nextOffset, loading, filter, fetchPage]);

  // Lightbox keyboard navigation. Only bound while a photo is open.
  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setLightboxIndex(null);
      if (ev.key === "ArrowRight")
        setLightboxIndex((i) => (i === null ? null : Math.min(items.length - 1, i + 1)));
      if (ev.key === "ArrowLeft")
        setLightboxIndex((i) => (i === null ? null : Math.max(0, i - 1)));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, items.length]);

  const activeItem = lightboxIndex !== null ? items[lightboxIndex] : null;

  // Apply a set of just-deleted ids to the local view. Kept centralised so the
  // grid, counts, and uploader summary update as a unit — otherwise an
  // in-flight paginated fetch could reappear a "deleted" row in the grid
  // while its uploader pill count has already ticked down. We collect the
  // per-uploader deltas OUTSIDE the setItems updater so StrictMode's
  // dev-time double-invocation can't double-count.
  const applyDeletion = useCallback(
    (deletedIds: string[], affected: GalleryItem[]) => {
      if (deletedIds.length === 0 || affected.length === 0) return;
      const removed = new Set(deletedIds);
      const perToken = new Map<string, number>();
      for (const it of affected) {
        const key = it.uploaderToken ?? "";
        perToken.set(key, (perToken.get(key) ?? 0) + 1);
      }
      setItems((prev) => prev.filter((i) => !removed.has(i.id)));
      setUploaderSummary((prev) => {
        const next = prev
          .map((u) => {
            const dec = perToken.get(u.token) ?? 0;
            return dec ? { ...u, count: Math.max(0, u.count - dec) } : u;
          })
          // Drop pills that hit zero so the filter row doesn't accumulate
          // dead uploaders after a moderator sweep.
          .filter((u) => u.count > 0);
        // If the currently-selected filter's uploader just hit zero, its
        // pill vanished — revert to "all" so the grid doesn't get stuck in
        // a "0 of N" state with no active pill. Reading `filter` from the
        // closure is safe: applyDeletion is called from a fresh handler
        // invocation, and useState guarantees `filter` is the render-time
        // value the handler saw.
        if (filter !== "all") {
          const targetKey = filter.token ?? "";
          if (!next.some((u) => u.token === targetKey)) {
            setFilter("all");
          }
        }
        return next;
      });
      setVisibleTotal((t) => Math.max(0, t - affected.length));
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
    },
    [filter],
  );

  const runDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return null;
      // Capture the affected items BEFORE the fetch — the applied deletion
      // needs their uploader tokens to decrement the pills, and we can't
      // read them off `items` inside applyDeletion because that closure is
      // memoised on eventId (not on items) to avoid churn.
      const idSet = new Set(ids);
      const affected = items.filter((i) => idSet.has(i.id));
      setDeleting(true);
      setDeleteError(null);
      try {
        const res = await fetch(`/api/events/${eventId}/media/delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { deleted: string[] };
        const deleted = body.deleted ?? [];
        const deletedSet = new Set(deleted);
        applyDeletion(deleted, affected.filter((i) => deletedSet.has(i.id)));
        return deleted;
      } catch {
        setDeleteError(
          ids.length === 1
            ? "Couldn't delete this photo. Try again."
            : `Couldn't delete ${ids.length} photos. Try again.`,
        );
        return null;
      } finally {
        setDeleting(false);
      }
    },
    [eventId, items, applyDeletion],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((v) => {
      if (v) setSelected(new Set());
      return !v;
    });
    setDeleteError(null);
  }, []);

  const toggleItemSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onThumbClick = useCallback(
    (id: string, index: number) => {
      if (selectMode) {
        toggleItemSelected(id);
      } else {
        setLightboxIndex(index);
      }
    },
    [selectMode, toggleItemSelected],
  );

  const onDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    const label = count === 1 ? "this photo" : `${count} photos`;
    if (!window.confirm(`Delete ${label}? Guests won't see them anymore.`)) return;
    const deleted = await runDelete(Array.from(selected));
    if (deleted && deleted.length > 0) {
      // Leave select mode after a successful sweep so the UI returns to the
      // normal grid — matches the mental model of "I'm done moderating".
      setSelectMode(false);
      setSelected(new Set());
    }
  }, [selected, runDelete]);

  const onDeleteFromLightbox = useCallback(
    async (item: GalleryItem, atIndex: number) => {
      if (!window.confirm("Delete this photo? Guests won't see it anymore.")) return;
      const deleted = await runDelete([item.id]);
      if (deleted && deleted.length === 1) {
        // Advance to the next photo if there is one, otherwise close the
        // lightbox. `items` in this closure is the PRE-deletion snapshot —
        // React's state hasn't flushed yet inside this handler — so the
        // post-deletion length is items.length - deleted.length.
        setLightboxIndex((current) => {
          if (current === null) return null;
          const nextLen = items.length - deleted.length;
          if (nextLen <= 0) return null;
          return Math.min(atIndex, nextLen - 1);
        });
      }
    },
    [runDelete, items.length],
  );

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[15px] uppercase tracking-[0.02em] text-daylight-ink">
            Recent uploads
          </h2>
          <p className="mt-1 font-mono text-xs text-daylight-muted">
            {filter === "all"
              ? `${visibleTotal} ${visibleTotal === 1 ? "shot" : "shots"} in the roll`
              : `${filterTotal} of ${visibleTotal}`}
          </p>
        </div>
        {visibleTotal > 0 && (
          <button
            type="button"
            onClick={toggleSelectMode}
            className={
              "rounded-daylight-chip px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] transition active:scale-[0.95] " +
              (selectMode
                ? "bg-daylight-orange-grad text-white"
                : "border border-daylight-rule bg-white/60 text-daylight-ink-soft")
            }
            aria-pressed={selectMode}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        )}
      </div>

      {uploaderSummary.length > 0 && (
        <div
          role="tablist"
          aria-label="Filter photos by uploader"
          className="mt-4 flex flex-wrap gap-2"
        >
          <FilterPill
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="Everyone"
            count={visibleTotal}
          />
          {uploaderSummary.map((u) => {
            const token = u.token === "" ? null : u.token;
            const active =
              filter !== "all" &&
              (filter.token === null ? token === null : filter.token === token);
            return (
              <FilterPill
                key={u.token === "" ? "__anon__" : u.token}
                active={active}
                onClick={() => setFilter({ token })}
                label={labelFor(u)}
                count={u.count}
              />
            );
          })}
        </div>
      )}

      {items.length === 0 && !loading ? (
        <div className="mt-5 rounded-daylight-card border border-daylight-rule bg-white/50 p-6 text-center">
          <p className="text-2xl">🎬</p>
          <p className="mt-2 text-sm text-daylight-ink-soft">
            {filter === "all"
              ? "No photos yet. Share the guest link to start collecting."
              : "No photos from this uploader."}
          </p>
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-3 gap-2 md:grid-cols-4 lg:gap-3">
          {items.map((item, index) => {
            const isSelected = selected.has(item.id);
            return (
              <li key={item.id}>
                {/* Polaroid print: white frame, photo, uploader-name chin. */}
                <button
                  type="button"
                  onClick={() => onThumbClick(item.id, index)}
                  aria-pressed={selectMode ? isSelected : undefined}
                  className={
                    "group relative block w-full rounded-[4px] bg-white p-[5px] pb-1.5 text-left shadow-[0_4px_10px_rgba(90,70,30,0.14)] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-daylight-orange" +
                    (selectMode && isSelected
                      ? " ring-2 ring-daylight-orange"
                      : "")
                  }
                  aria-label={
                    selectMode
                      ? isSelected
                        ? "Deselect photo"
                        : "Select photo"
                      : item.uploaderName
                        ? `Photo by ${item.uploaderName}`
                        : "Photo by a guest"
                  }
                >
                  <span className="block aspect-square overflow-hidden rounded-[2px] bg-daylight-paper-edge">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className={
                        "h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" +
                        (selectMode && isSelected ? " opacity-70" : "")
                      }
                    />
                  </span>
                  <span className="mt-1 block truncate px-0.5 font-mono text-[10px] font-bold text-daylight-muted">
                    {item.uploaderName ?? "Anonymous"}
                  </span>
                  {selectMode && (
                    <span
                      aria-hidden="true"
                      className={
                        "absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shadow " +
                        (isSelected
                          ? "bg-daylight-orange-grad text-white"
                          : "border border-daylight-rule bg-white/80 text-daylight-muted")
                      }
                    >
                      {isSelected ? "✓" : ""}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div className="mt-5 flex items-center gap-3 rounded-daylight-field border border-daylight-red/50 bg-daylight-red/10 px-4 py-3 text-sm text-daylight-red-deep">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => nextOffset !== null && fetchPage(nextOffset, filter, "append")}
            className="rounded-daylight-chip border border-daylight-red/50 px-3 py-1 font-mono text-xs font-bold text-daylight-red-deep transition hover:bg-daylight-red/10"
          >
            Retry
          </button>
        </div>
      )}

      {deleteError && (
        <div
          role="alert"
          className="mt-5 rounded-daylight-field border border-daylight-red/50 bg-daylight-red/10 px-4 py-3 text-sm text-daylight-red-deep"
        >
          {deleteError}
        </div>
      )}

      {hasMore && (
        <div
          ref={sentinelRef}
          className="mt-6 flex items-center justify-center py-6 font-mono text-xs text-daylight-muted"
          aria-hidden={!hasMore}
        >
          {loading ? "Loading more…" : "Scroll for more"}
        </div>
      )}

      {selectMode && (
        <div
          role="region"
          aria-label="Selection actions"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-[13px] border border-daylight-rule bg-daylight-paper/95 px-4 py-2.5 shadow-daylight-card backdrop-blur">
            <span className="font-mono text-xs font-bold text-daylight-ink-soft">
              {selected.size === 0
                ? "Tap photos to select"
                : `${selected.size} selected`}
            </span>
            <button
              type="button"
              onClick={onDeleteSelected}
              disabled={selected.size === 0 || deleting}
              className="rounded-[9px] bg-daylight-red px-3 py-1.5 font-mono text-xs font-bold text-white shadow transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-daylight-ink/10 disabled:text-daylight-muted"
            >
              {deleting ? "Deleting…" : `Delete${selected.size ? ` ${selected.size}` : ""}`}
            </button>
            <button
              type="button"
              onClick={toggleSelectMode}
              className="rounded-[9px] border border-daylight-rule px-3 py-1.5 font-mono text-xs text-daylight-ink transition hover:bg-white/60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {activeItem && lightboxIndex !== null && (
        <Lightbox
          item={activeItem}
          onClose={() => setLightboxIndex(null)}
          onPrev={
            lightboxIndex > 0
              ? () => setLightboxIndex(lightboxIndex - 1)
              : null
          }
          onNext={
            lightboxIndex < items.length - 1
              ? () => setLightboxIndex(lightboxIndex + 1)
              : null
          }
          onDelete={() => onDeleteFromLightbox(activeItem, lightboxIndex)}
          deleting={deleting}
        />
      )}
    </section>
  );
}

function FilterPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "rounded-daylight-chip px-2.5 py-1 font-mono text-[11px] font-bold transition active:scale-[0.95] " +
        (active
          ? "bg-daylight-orange-grad text-white"
          : "border border-daylight-rule bg-white/60 text-daylight-ink-soft")
      }
    >
      {label}
      <span className={active ? "ml-1 text-white/80" : "ml-1 text-daylight-muted"}>
        {count}
      </span>
    </button>
  );
}

function Lightbox({
  item,
  onClose,
  onPrev,
  onNext,
  onDelete,
  deleting,
}: {
  item: GalleryItem;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onDelete: () => void;
  deleting: boolean;
}) {
  // Close on backdrop click but not on clicks inside the image container.
  function onBackdropKey(ev: ReactKeyboardEvent<HTMLDivElement>) {
    if (ev.key === "Enter" || ev.key === " ") onClose();
  }

  // D3 lightbox treatment: dark ink scrim over the paper, the photo as a
  // large white print, paper-toned metadata.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.uploaderName ? `Photo by ${item.uploaderName}` : "Photo"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(24,16,6,0.86)] p-4 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={onBackdropKey}
      tabIndex={-1}
    >
      <div
        className="relative flex max-h-full max-w-full flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rounded-[4px] bg-white p-2 pb-7 shadow-daylight-print-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={item.uploaderName ? `Photo by ${item.uploaderName}` : "Photo"}
            className="max-h-[76vh] max-w-[88vw] rounded-[2px] object-contain"
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 font-mono text-xs text-[#b7a988]">
          <span className="font-bold text-daylight-paper">
            {item.uploaderName ?? "Anonymous"}
          </span>
          <span>·</span>
          <time dateTime={item.createdAt}>
            {new Date(item.createdAt).toLocaleString()}
          </time>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="rounded-daylight-chip border border-red-400/40 bg-red-500/15 px-3 py-1 font-bold text-red-200 transition hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
        <div className="absolute inset-y-0 left-0 flex items-center">
          {onPrev && (
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous photo"
              className="ml-2 flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/10 text-lg text-daylight-paper backdrop-blur transition hover:bg-white/20"
            >
              ‹
            </button>
          )}
        </div>
        <div className="absolute inset-y-0 right-0 flex items-center">
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              aria-label="Next photo"
              className="mr-2 flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/10 text-lg text-daylight-paper backdrop-blur transition hover:bg-white/20"
            >
              ›
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -right-2 -top-2 flex h-9 w-9 items-center justify-center rounded-full bg-daylight-paper text-sm text-daylight-ink shadow-daylight-card transition hover:bg-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
