import type { SupabaseClient } from "@supabase/supabase-js";
import { GALLERY_BUCKET } from "./queries";
import { createServiceClient } from "@/lib/supabase/service";

// FRI-18 — streamed ZIP export helpers for the host "Download all" flow.
// Kept out of the route file so the pieces are unit-testable without spinning
// up the archiver + Node stream plumbing. TECH_SPEC §6 §10.

// Page size for the media walker. Chosen so:
//   - The batch signed-URL call (createSignedUrls) is one round-trip per page.
//   - Peak signed URLs held in memory ≈ 200 short strings, cheap.
//   - We never load a 1,000-photo event's entire row set at once.
// The archiver consumes entries one-at-a-time (see the route), so this page
// size does not bound peak network sockets — only DB + signing round-trips.
export const DOWNLOAD_BATCH_SIZE = 200;

// Signed URL TTL for the ZIP path. A large event's total transfer can take
// many minutes; 30 minutes gives comfortable headroom while still expiring
// leaked URLs long before they become a broad exposure. The URLs are per-batch
// so a stalled connection re-signs the next page freshly on resume.
export const DOWNLOAD_SIGNED_URL_TTL_SECONDS = 60 * 30;

export type DownloadMediaRow = {
  id: string;
  storage_path: string;
  uploader_token: string | null;
  uploader_name: string | null;
  created_at: string;
};

// Walk the event's downloadable media newest-first, one page at a time. Kept
// as an async generator so the caller can await each page, stream it into the
// ZIP, and *then* fetch the next — memory stays flat regardless of gallery
// size. RLS on `media` scopes rows to events owned by the caller; the route's
// ownsEvent() precheck exists so a foreign id 404s rather than serving an
// empty ZIP.
//
// FRI-30: the default ZIP is the public roll — approved only. The host can
// opt pending (not-yet-approved) shots in; rejected rows never export.
export async function* iterateDownloadableMedia(
  supabase: SupabaseClient,
  eventId: string,
  batchSize: number = DOWNLOAD_BATCH_SIZE,
  { includePending = false }: { includePending?: boolean } = {},
): AsyncGenerator<DownloadMediaRow[], void, void> {
  const statuses = includePending ? ["pending", "approved"] : ["approved"];
  let offset = 0;
  // Loop bound: each page returns ≤ batchSize rows. When Postgres returns a
  // short page we're done. `while (true)` with an explicit break beats a
  // hard cap because a hard cap would silently truncate a very large event.
  while (true) {
    const { data, error } = await supabase
      .from("media")
      .select("id, storage_path, uploader_token, uploader_name, created_at")
      .eq("event_id", eventId)
      .in("status", statuses)
      // Photos-only per TECH_SPEC §1 — the outer ZIP filename literally
      // says `-photos-`, and if the video lane ever lands the export
      // format for it should be a separate decision, not a filename lie.
      .eq("kind", "photo")
      // Ordering must match media_event_created_idx so the planner serves
      // pagination without a sort. Same tie-breaker as the gallery grid so
      // a host's ZIP and gallery order are consistent.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + batchSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as DownloadMediaRow[];
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    offset += rows.length;
  }
}

// Bulk-sign one page's storage paths. Returns a Map keyed by storage_path so
// the caller can join back to the row order. Nulls (deleted object under a
// row) are omitted; the route logs them and skips the entry so a stray
// missing object doesn't abort the whole download.
export async function signPathsForDownload(
  paths: string[],
  ttlSeconds: number = DOWNLOAD_SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;
  const svc = createServiceClient();
  const { data, error } = await svc.storage
    .from(GALLERY_BUCKET)
    .createSignedUrls(paths, ttlSeconds);
  if (error || !data) {
    // Distinguish "signer said no" (batch-level failure — the whole page is
    // missing from the ZIP) from a per-row null downstream. A silent map
    // return would look identical to "everything signed, nothing dropped"
    // when in reality up to DOWNLOAD_BATCH_SIZE items were skipped.
    console.warn(
      `[download] createSignedUrls failed for ${paths.length} paths:`,
      error?.message ?? "no data",
    );
    return urls;
  }
  for (const row of data) {
    if (row.path && row.signedUrl) urls.set(row.path, row.signedUrl);
  }
  return urls;
}

// Extract a lowercase extension from a storage_path or return "" if none.
// storage_path shape is `events/{event_id}/{uuid}.jpg` — the extension lives
// in the basename after the last dot.
function extOf(storagePath: string): string {
  const basename = storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return "";
  return basename.slice(dot).toLowerCase();
}

// Turn a free-form uploader name into a filesystem-safe folder segment.
// Strips anything not alphanumeric/dash/underscore, collapses runs of dashes,
// caps length so a hostile name can't push a path past ZIP limits. Empty
// output → "guest" (RARE — the caller's already routed anonymous to a
// different folder), which stays inside the "attribution folder" mental model.
export function safeUploaderSlug(name: string | null): string {
  if (!name) return "guest";
  const stripped = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    .toLowerCase();
  return stripped.length > 0 ? stripped : "guest";
}

// Build the entry name for a media row inside the ZIP. Rules:
//   - Top-level folder groups by uploader → `by-<slug>/` or `anonymous/`.
//   - Filename encodes the created-at date (chronological browsing in the
//     host's file manager) + the media id's short prefix (uniqueness even
//     when two guests happened to share a date and uploader name).
//   - Extension is preserved verbatim from the stored object.
// The `seenNames` set is threaded through the caller so the same base cannot
// collide across pages — a paranoid guard given the id-prefix strategy, but
// two rows with the same 8-char id prefix aren't impossible on a huge event.
export function zipEntryName(
  row: DownloadMediaRow,
  seenNames: Set<string>,
): string {
  const folder =
    row.uploader_token === null || row.uploader_token === ""
      ? "anonymous"
      : `by-${safeUploaderSlug(row.uploader_name)}`;
  const shortId = row.id.replace(/-/g, "").slice(0, 8);
  const date = row.created_at.slice(0, 10); // YYYY-MM-DD
  const ext = extOf(row.storage_path);
  const base = `${folder}/${date}-${shortId}${ext}`;
  if (!seenNames.has(base)) {
    seenNames.add(base);
    return base;
  }
  // Collision fallback: append the row id (fully unique) before the extension.
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = `${stem}-${row.id}${ext}`;
  let counter = 1;
  while (seenNames.has(name)) {
    name = `${stem}-${row.id}-${counter}${ext}`;
    counter += 1;
  }
  seenNames.add(name);
  return name;
}

// Build the outer ZIP filename shown to the host's browser. Uses the event
// slug so multiple downloads from different events are distinguishable in
// the Downloads folder. Includes today's date so re-downloading a growing
// gallery produces a new file rather than overwriting an old one.
export function zipDownloadFilename(slug: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  const safeSlug = slug.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "event";
  return `${safeSlug}-photos-${date}.zip`;
}
