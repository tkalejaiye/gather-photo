import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

// Host gallery data access. All queries here run under an
// authenticated Supabase client — RLS on `events` and `media` scopes
// results to the calling host's own events (TECH_SPEC §9). The service
// client is used ONLY to mint signed URLs (host-authenticated clients
// have no RLS policy against storage.objects; see 0003_storage_rls.sql
// which only opens SELECT to `anon` within the event-open window).

export const GALLERY_BUCKET = "event-media";

// Short-lived signed URLs — the spec calls for these to keep media reads
// bounded so leaked URLs stale out quickly. 5 minutes is long enough for
// a host to browse and lightbox a page without churn, short enough that
// a leaked URL is unusable minutes later.
export const SIGNED_URL_TTL_SECONDS = 300;

// Grid page size — a 1,000-photo event pages 17 times end-to-end. Chosen
// so a modern host device downloads ~30-60 MB of compressed images per
// page (each ~500-1000 KB) even if every thumb decompresses at once.
export const DEFAULT_PAGE_SIZE = 60;
export const MAX_PAGE_SIZE = 200;

// FRI-30 approval vocabulary. 'rejected' (the FRI-17 soft-delete, renamed)
// exists in the DB but never leaves it — every query in this module filters
// to the host-visible pair, so a rejected row is invisible to grid, counts,
// pills, and ZIP alike.
//
// Visibility contract (TECH_SPEC §9):
//   host          → pending + approved (this module)
//   public/guest  → approved ONLY (pass status:"approved" — the guest
//                   landing count does; the FRI-37 guest gallery must too,
//                   plus its own uploader_token's pending rows)
export type MediaStatus = "pending" | "approved";
export const HOST_VISIBLE_STATUSES: MediaStatus[] = ["pending", "approved"];

export type GalleryMediaRow = {
  id: string;
  storage_path: string;
  uploader_token: string | null;
  uploader_name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
  status: MediaStatus;
};

export type GalleryItem = {
  id: string;
  url: string;
  path: string;
  uploaderToken: string | null;
  uploaderName: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string;
  status: MediaStatus;
};

export type GalleryPage = {
  items: GalleryItem[];
  hasMore: boolean;
  nextOffset: number | null;
};

export type UploaderSummaryRow = {
  uploader_token: string;
  display_name: string | null;
  media_count: number;
};

export type UploaderSummary = {
  // The empty string represents unattributed (anonymous) uploads. Kept as
  // "" throughout the wire format so the client filter can use it as an
  // opaque token; presentation-layer code substitutes "Anonymous" as needed.
  token: string;
  displayName: string | null;
  count: number;
};

// Verify the caller owns the event. RLS on `events` gives us this for free:
// a select scoped to (id + auth.uid()) returns null if the event isn't the
// host's, without leaking that the id exists.
export async function ownsEvent(
  supabase: SupabaseClient,
  eventId: string,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .maybeSingle();
  return data ?? null;
}

type FetchMediaOptions = {
  offset?: number;
  limit?: number;
  uploaderToken?: string | null;
  // Narrow to one host-visible status ('pending' drives the moderation-queue
  // filter). Omitted → both pending and approved. 'rejected' is deliberately
  // not accepted: nothing should page through soft-deleted rows.
  status?: MediaStatus;
};

// Fetch one page of host-visible media for a host-owned event. RLS on `media`
// enforces ownership; ownsEvent() should still run first so a foreign
// event id returns a clean 404 rather than an empty page.
export async function fetchMediaPage(
  supabase: SupabaseClient,
  eventId: string,
  { offset = 0, limit = DEFAULT_PAGE_SIZE, uploaderToken, status }: FetchMediaOptions = {},
): Promise<GalleryMediaRow[]> {
  // MAX_PAGE_SIZE clamping lives in loadGalleryPage (the public entry point).
  // Clamping again here would silently eat the `limit + 1` look-ahead when a
  // caller requests exactly MAX_PAGE_SIZE, breaking hasMore.
  const safeLimit = Math.max(1, limit);
  const safeOffset = Math.max(0, Math.floor(offset));

  // Filters go BEFORE order+range because Supabase's builder finalizes into
  // a thenable once `.range()` is called — we lose the ability to chain
  // predicates after. `uploaderToken === undefined` (the default) means
  // "no filter"; explicit `null` or `""` means anonymous only; a non-empty
  // string filters to a specific uploader.
  let q = supabase
    .from("media")
    .select(
      "id, storage_path, uploader_token, uploader_name, width, height, bytes, created_at, status",
    )
    .eq("event_id", eventId);

  // Host default: everything reviewable (pending + approved). A narrowed
  // status uses .eq so the planner can serve it straight off
  // media_event_created_idx's (event_id, status, …) prefix.
  q = status ? q.eq("status", status) : q.in("status", HOST_VISIBLE_STATUSES);

  if (uploaderToken !== undefined) {
    if (uploaderToken === null || uploaderToken === "") {
      q = q.is("uploader_token", null);
    } else {
      q = q.eq("uploader_token", uploaderToken);
    }
  }

  // Composite order matches media_event_created_idx (0004_gallery.sql) so the
  // planner can serve pagination without a sort step.
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (error) throw error;
  return (data ?? []) as GalleryMediaRow[];
}

// Bulk-sign one page's paths. Supabase's createSignedUrls accepts a batch and
// returns one signed URL per input, preserving order. Per-row nulls (deleted
// object under a row) are dropped in the Map so loadGalleryPage's join can
// filter the corresponding row out of the returned page. A batch-level error
// yields an empty Map — the caller then serves a shorter page, which surfaces
// the outage rather than hiding it behind a stale HTML render.
export async function signPaths(
  paths: string[],
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;
  const svc = createServiceClient();
  const { data, error } = await svc.storage
    .from(GALLERY_BUCKET)
    .createSignedUrls(paths, ttlSeconds);
  if (error || !data) return urls;
  for (const row of data) {
    if (row.path && row.signedUrl) urls.set(row.path, row.signedUrl);
  }
  return urls;
}

// Assemble one page: fetch rows, sign paths, join. Used by both the server
// component (initial page) and the API route (subsequent pages).
export async function loadGalleryPage(
  supabase: SupabaseClient,
  eventId: string,
  opts: FetchMediaOptions = {},
): Promise<GalleryPage> {
  const rawLimit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(1, rawLimit), MAX_PAGE_SIZE);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  // Fetch limit + 1 to detect "there's more". Cheaper than a COUNT.
  const rows = await fetchMediaPage(supabase, eventId, {
    ...opts,
    offset,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const urls = await signPaths(page.map((r) => r.storage_path));

  const items: GalleryItem[] = page
    // Drop rows the signer couldn't produce a URL for — the object was
    // deleted underneath us or the storage API glitched. Better to render a
    // slightly shorter page than a broken thumb.
    .filter((r) => urls.has(r.storage_path))
    .map((r) => ({
      id: r.id,
      url: urls.get(r.storage_path)!,
      path: r.storage_path,
      uploaderToken: r.uploader_token,
      uploaderName: r.uploader_name,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      createdAt: r.created_at,
      status: r.status,
    }));

  return {
    items,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

// Media count for the event. The `head: true` variant does not return rows —
// just the exact count from the DB — so a 1,000-photo event costs one COUNT
// rather than a full scan.
//
// Status selects the audience: omitted → host view (pending + approved);
// "approved" → the ONLY count any guest-facing surface may show (the landing
// pill uses it; TECH_SPEC §9); "pending" → the moderation-queue badge.
export async function fetchTotalCount(
  supabase: SupabaseClient,
  eventId: string,
  status?: MediaStatus,
): Promise<number> {
  let q = supabase
    .from("media")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId);
  q = status ? q.eq("status", status) : q.in("status", HOST_VISIBLE_STATUSES);
  const { count } = await q;
  return count ?? 0;
}

// Grouped uploader counts via the 0004_gallery.sql RPC. Ordered by descending
// media_count so the busiest uploader leads the filter UI.
export async function fetchUploaderSummary(
  supabase: SupabaseClient,
  eventId: string,
): Promise<UploaderSummary[]> {
  const { data, error } = await supabase.rpc("event_uploader_counts", {
    p_event_id: eventId,
  });
  if (error || !data) return [];
  return (data as UploaderSummaryRow[]).map((row) => ({
    token: row.uploader_token,
    displayName: row.display_name && row.display_name.length > 0 ? row.display_name : null,
    count: Number(row.media_count),
  }));
}
