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
    // 23505 = unique violation on (event_id, content_hash). M1 treats this
    // as success so the guest UI doesn't show a confusing failure when they
    // accidentally pick the same photo twice. FRI-15 will return the
    // pre-existing media row id explicitly.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      // No row will reference the just-uploaded object — remove it so we
      // don't accumulate orphans whenever a guest re-picks the same photo.
      // Best-effort: failure here means the object lingers until
      // `storage_expires_at` cleanup, which is acceptable.
      await supabase.storage.from(MEDIA_BUCKET).remove([path]).catch(() => {});
      return NextResponse.json({ mediaId: null, duplicate: true });
    }
    return NextResponse.json(
      { error: "Could not register upload." },
      { status: 500 },
    );
  }

  return NextResponse.json({ mediaId: data.id, duplicate: false });
}
