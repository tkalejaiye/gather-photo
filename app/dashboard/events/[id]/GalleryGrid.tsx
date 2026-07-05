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

// FRI-16: host gallery grid.
// - Uploader filter (Everyone + one pill per uploader token, including anon)
// - Responsive thumbnail grid served by short-lived signed URLs (server-side)
// - Lazy-loaded next pages via IntersectionObserver
// - Tap a thumbnail for full-size lightbox
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

function filterKey(f: FilterValue): string {
  if (f === "all") return "all";
  return f.token === null ? "anon" : `t:${f.token}`;
}

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

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guard against concurrent fetches when the sentinel becomes visible while a
  // page is still in-flight. Also lets us abort in-flight requests when the
  // filter changes so a slow first page can't clobber a fresh selection.
  const abortRef = useRef<AbortController | null>(null);

  // The filter total drives the "Showing X of Y" line without an extra API
  // trip. Falls back to totalCount when the "all" filter is active.
  const filterTotal = useMemo(() => {
    if (filter === "all") return totalCount;
    const match = uploaders.find(
      (u) => (filter.token === null ? u.token === "" : u.token === filter.token),
    );
    return match?.count ?? 0;
  }, [filter, totalCount, uploaders]);

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

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-neutral-200">
          Photos ·{" "}
          <span className="text-neutral-100">
            {filter === "all" ? totalCount : `${filterTotal} of ${totalCount}`}
          </span>
        </h2>
      </div>

      {uploaders.length > 0 && (
        <div
          role="tablist"
          aria-label="Filter photos by uploader"
          className="mt-3 flex flex-wrap gap-2"
        >
          <FilterPill
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="Everyone"
            count={totalCount}
          />
          {uploaders.map((u) => {
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
        <p className="mt-6 text-sm text-neutral-500">
          {filter === "all"
            ? "No photos yet. Share the guest link to start collecting."
            : "No photos from this uploader."}
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setLightboxIndex(index)}
                className="group block aspect-square w-full overflow-hidden rounded bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand"
                aria-label={
                  item.uploaderName
                    ? `Photo by ${item.uploaderName}`
                    : "Photo by a guest"
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition group-hover:opacity-90"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-3 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => nextOffset !== null && fetchPage(nextOffset, filter, "append")}
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-100 hover:border-red-600"
          >
            Retry
          </button>
        </div>
      )}

      {hasMore && (
        <div
          ref={sentinelRef}
          className="mt-6 flex items-center justify-center py-6 text-xs text-neutral-500"
          aria-hidden={!hasMore}
        >
          {loading ? "Loading more…" : "Scroll for more"}
        </div>
      )}

      {activeItem && (
        <Lightbox
          item={activeItem}
          onClose={() => setLightboxIndex(null)}
          onPrev={
            lightboxIndex !== null && lightboxIndex > 0
              ? () => setLightboxIndex(lightboxIndex - 1)
              : null
          }
          onNext={
            lightboxIndex !== null && lightboxIndex < items.length - 1
              ? () => setLightboxIndex(lightboxIndex + 1)
              : null
          }
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
        active
          ? "rounded-full bg-brand px-3 py-1 text-xs font-medium text-white"
          : "rounded-full border border-neutral-800 bg-neutral-950 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
      }
    >
      {label}
      <span className="ml-1.5 text-neutral-400">{count}</span>
    </button>
  );
}

function Lightbox({
  item,
  onClose,
  onPrev,
  onNext,
}: {
  item: GalleryItem;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  // Close on backdrop click but not on clicks inside the image container.
  function onBackdropKey(ev: ReactKeyboardEvent<HTMLDivElement>) {
    if (ev.key === "Enter" || ev.key === " ") onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.uploaderName ? `Photo by ${item.uploaderName}` : "Photo"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      onKeyDown={onBackdropKey}
      tabIndex={-1}
    >
      <div
        className="relative flex max-h-full max-w-full flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.url}
          alt={item.uploaderName ? `Photo by ${item.uploaderName}` : "Photo"}
          className="max-h-[85vh] max-w-[90vw] rounded object-contain"
        />
        <div className="mt-3 flex items-center gap-3 text-xs text-neutral-300">
          <span>{item.uploaderName ?? "Anonymous"}</span>
          <span className="text-neutral-500">·</span>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
        </div>
        <div className="absolute inset-y-0 left-0 flex items-center">
          {onPrev && (
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous photo"
              className="ml-2 h-10 w-10 rounded-full bg-neutral-900/80 text-neutral-100 hover:bg-neutral-800"
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
              className="mr-2 h-10 w-10 rounded-full bg-neutral-900/80 text-neutral-100 hover:bg-neutral-800"
            >
              ›
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -right-2 -top-2 h-8 w-8 rounded-full bg-neutral-900 text-neutral-100 shadow hover:bg-neutral-800"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
