import { NextResponse } from "next/server";
import { createStorageClient, MEDIA_BUCKET, resolveOpenEvent } from "@/lib/upload/server";

// POST /api/uploads/register
// Body: {
//   slug, path, bytes, width?, height?, contentHash,
//   uploaderToken, uploaderName?
// }
// Returns: { mediaId, duplicate: boolean }
//
// Called AFTER the client PUTs the blob to the signed URL. Inserts the
// `media` row so the host gallery can see the photo. Re-validates that the
// event is still active+unexpired — the sign step might be minutes old.
//
// Designed for FRI-15 (M2 dedupe): the `(event_id, content_hash)` unique
// index already exists. Today we collapse the 23505 conflict path into a
// "duplicate=true" success so FRI-15 can layer richer behaviour (returning
// the existing row, skipping the storage upload) without rewriting callers.
//
// TODO(spec §9): add rate limiting (per IP + per uploader_token) before a
// real event — the route inserts rows and triggers storage I/O.
export const runtime = "nodejs";

// Path component allowlist — `events/{eventId}/{uuid}.{ext}`. Rejecting
// anything outside this shape closes off path traversal attempts on top of
// the explicit prefix check below.
const PATH_TAIL = /^[a-zA-Z0-9-]+\.[a-z0-9]{1,5}$/;

type Body = {
  slug?: unknown;
  path?: unknown;
  bytes?: unknown;
  width?: unknown;
  height?: unknown;
  contentHash?: unknown;
  uploaderToken?: unknown;
  uploaderName?: unknown;
};

const MAX_BYTES = 30 * 1024 * 1024; // matches storage bucket file_size_limit

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asPositiveInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const slug = asString(body.slug);
  const path = asString(body.path);
  const contentHash = asString(body.contentHash);
  const uploaderToken = asString(body.uploaderToken);
  const bytes = asPositiveInt(body.bytes);
  const width = asPositiveInt(body.width);
  const height = asPositiveInt(body.height);
  const uploaderName =
    typeof body.uploaderName === "string" && body.uploaderName.trim()
      ? body.uploaderName.trim().slice(0, 60)
      : null;

  if (!slug || !path || !contentHash || !uploaderToken || bytes === null) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }
  if (bytes > MAX_BYTES) {
    return NextResponse.json({ error: "File too large." }, { status: 413 });
  }

  const resolved = await resolveOpenEvent(slug);
  if (!resolved.ok) {
    const msg = resolved.status === 401 ? "PIN required." : "Event not available.";
    return NextResponse.json({ error: msg }, { status: resolved.status });
  }
  const { event } = resolved;

  // Ties the registered row to the slug's event — even if the client tampers
  // with `path`, it can only register an object under its own event.
  const prefix = `events/${event.id}/`;
  if (!path.startsWith(prefix)) {
    return NextResponse.json({ error: "Path does not match event." }, { status: 400 });
  }
  const tail = path.slice(prefix.length);
  if (path.includes("..") || !PATH_TAIL.test(tail)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  const supabase = createStorageClient();

  // Confirm the storage object actually exists before we insert a row that
  // points at it. Without this, a client could call /register without ever
  // uploading and litter the gallery with broken thumbnails.
  const { data: head, error: headErr } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, 60);
  if (headErr || !head) {
    return NextResponse.json({ error: "Uploaded object not found." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("media")
    .insert({
      event_id: event.id,
      uploader_token: uploaderToken,
      uploader_name: uploaderName,
      storage_path: path,
      kind: "photo",
      bytes,
      width,
      height,
      content_hash: contentHash,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique violation on (event_id, content_hash). Two cases we
    // handle here — telling them apart matters for the FRI-13 resumable path.
    //   (a) SAME-PATH RETRY: the resumable uploader's `register` call landed
    //       twice because a dropped response after a successful first insert
    //       forced a retry. `storage_path` matches the row that's already in
    //       the DB — the object at `path` IS the object the existing row
    //       references. Removing it here would nuke a successfully-registered
    //       photo. Return the existing id idempotently instead.
    //   (b) DIFFERENT-PATH DEDUPE: the FRI-11 direct-upload flow assigns a
    //       fresh UUID path per attempt, so the guest picking the same photo
    //       twice ends up with two different `path`s that share a content
    //       hash. The old row references the earlier path; the newly uploaded
    //       object at `path` is an orphan and should be removed.
    // Either way we return the existing mediaId so callers can attribute the
    // media without an extra round-trip (FRI-15 will lean on this).
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const { data: existing } = await supabase
        .from("media")
        .select("id, storage_path")
        .eq("event_id", event.id)
        .eq("content_hash", contentHash)
        .maybeSingle();
      const isSamePathRetry = existing?.storage_path === path;
      if (!isSamePathRetry) {
        // Best-effort: failure to remove means the orphan lingers until
        // `storage_expires_at` cleanup, which is acceptable.
        await supabase.storage.from(MEDIA_BUCKET).remove([path]).catch(() => {});
      }
      return NextResponse.json({
        mediaId: existing?.id ?? null,
        duplicate: true,
      });
    }
    return NextResponse.json(
      { error: "Could not register upload." },
      { status: 500 },
    );
  }

  return NextResponse.json({ mediaId: data.id, duplicate: false });
}
