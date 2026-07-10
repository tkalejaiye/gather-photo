import { NextResponse } from "next/server";
import { createStorageClient, MEDIA_BUCKET, resolveOpenEvent } from "@/lib/upload/server";
import { checkRateLimit } from "@/lib/upload/rate-limit";

// POST /api/uploads/register
// Body: {
//   slug, path, bytes, width?, height?, contentHash,
//   uploaderToken, uploaderName?
// }
// Returns: { mediaId, duplicate: boolean, status: 'pending' | 'approved' }
//
// Called AFTER the client PUTs the blob to the signed URL. Inserts the
// `media` row so the host gallery can see the photo. Re-validates that the
// event is still active+unexpired — the sign step might be minutes old.
//
// Dedupe (FRI-15): the `(event_id, content_hash)` unique index in
// supabase/migrations/0001_init.sql collapses re-registers to a single row;
// the 23505 branch below returns the existing mediaId with `duplicate: true`
// so the resumable uploader (`lib/upload/uploader.ts`) can attribute the
// media on a retry without an extra round-trip.
export const runtime = "nodejs";

// Rate limit (FRI-15 / TECH_SPEC §9): the register route inserts rows and
// triggers storage I/O — a hostile client could otherwise inflate storage
// costs and the media table. 60 requests / minute per (IP, uploaderToken) is
// well above the ~30-photo burst a real guest generates on the queue drain
// (`lib/upload/uploader.ts:147`) but bounds a floodgate. IP alone would 429
// two legitimate guests behind the same venue NAT; token alone is client-
// controlled — the composite is what the TODO originally called for.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

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

// Prefer the first `x-forwarded-for` hop when the app runs behind Vercel /
// Cloudflare (the proxies append the real client IP to the left). Fall back
// to `x-real-ip` (common with plain nginx), then to a fixed sentinel so an
// unproxied local request still shares a rate-limit bucket instead of every
// call getting its own `unknown` key.
function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
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

  // Rate limit check is deliberately AFTER body validation so a malformed
  // body still 400s (no need to count it) but BEFORE the DB/Storage calls
  // that make this route expensive. `|` separator (not `:`) because an IPv6
  // XFF value already contains colons and would ambiguate the key.
  const rl = checkRateLimit(`${getClientIp(req)}|${uploaderToken}`, {
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds) },
      },
    );
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

  // FRI-30: uploads await host approval before anything public can see
  // them. Explicit here (not just the column default) so the moderation
  // policy is visible at the insert site; auto_approve is the host's
  // per-event opt-out of moderating.
  const status = event.auto_approve ? "approved" : "pending";

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
      status,
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
    // media without an extra round-trip.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const { data: existing } = await supabase
        .from("media")
        .select("id, storage_path, status")
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
        // The EXISTING row's status is authoritative on a retry — the host
        // may already have approved (or rejected) it since the first
        // registration. Fall back to the would-be insert status only if
        // the row vanished between the 23505 and the re-read.
        status: existing?.status ?? status,
      });
    }
    return NextResponse.json(
      { error: "Could not register upload." },
      { status: 500 },
    );
  }

  // `status` rides along so the guest UI can distinguish "in the roll" from
  // "awaiting host approval" without another round-trip (FRI-37 will use it).
  return NextResponse.json({ mediaId: data.id, duplicate: false, status });
}
