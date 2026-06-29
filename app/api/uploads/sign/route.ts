import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  MEDIA_BUCKET,
  buildStoragePath,
  createStorageClient,
  extForContentType,
  resolveOpenEvent,
} from "@/lib/upload/server";

// POST /api/uploads/sign
// Body: { slug: string, contentType: string }
// Returns: { signedUrl, path, token, eventId }
//
// Issues a one-shot signed upload URL for a single object in the
// `event-media` bucket. The server picks the storage path so the register
// route can verify the client didn't claim someone else's object.
// TECH_SPEC §9: validated server-side; guests never touch the DB directly.
//
// TODO(spec §9): add rate limiting (per IP + per uploader_token) before
// running a real event. Without it, a single client could exhaust signed
// upload tokens and inflate storage costs.
export const runtime = "nodejs";

// Photos-first per spec §1 — explicitly reject anything that isn't an image
// so a buggy/hostile client can't write `.bin` blobs under `event-media`.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
]);

type Body = { slug?: unknown; contentType?: unknown };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  const contentType =
    typeof body.contentType === "string" && body.contentType
      ? body.contentType
      : "";
  if (!slug) {
    return NextResponse.json({ error: "Missing slug." }, { status: 400 });
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: "Unsupported content type." },
      { status: 415 },
    );
  }

  const resolved = await resolveOpenEvent(slug);
  if (!resolved.ok) {
    // 401 when the PIN cookie is missing/wrong; 404 otherwise so we don't
    // confirm whether an unknown slug exists. Matches the page-level
    // behaviour in `app/e/[slug]/page.tsx`.
    const msg = resolved.status === 401 ? "PIN required." : "Event not available.";
    return NextResponse.json({ error: msg }, { status: resolved.status });
  }

  const ext = extForContentType(contentType);
  const path = buildStoragePath(resolved.event.id, randomUUID(), ext);

  const supabase = createStorageClient();
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json(
      { error: "Could not issue upload URL." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    signedUrl: data.signedUrl,
    path: data.path,
    token: data.token,
    eventId: resolved.event.id,
  });
}
